import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { assertBalanced, documentTotals, roundToCash } from '../documentMath'
import { headroomRefusal } from '../creditRules'
import { toAccountType } from '../accountTypes'
import { nextDocumentNumber } from './sequences'
import { recordMovement, stockDirectionFor, canSellNow } from './stockMovements'
import { getTenderType, checkTenders, type TenderType } from './tenderTypes'
import { validateTerminalClaim } from './terminals'
import { openShiftFor } from './shifts'
import { getNumericSetting, isPeriodLocked } from './settings'
import { getDocument, isEditable, type SalesDocument } from './salesDocuments'
import { resolveComponents, type ResolvedComponent } from './productComposition'
import { checkSellable, markSold } from './serials'
import { postTransaction, reverseTransaction } from './customerLedger'
import type { Actor } from './activityLog'

/**
 * Finalise — the one moment a sale becomes real.
 *
 * EVERYTHING happens inside a single siteTransaction: stock moves, tenders are
 * recorded, the debtor ledger posts, and the document number is issued. Either
 * all of it commits or none of it does. A sale that moved stock but issued no
 * number, or issued a number but posted no ledger entry, is not recoverable by
 * any amount of tidying up afterwards.
 *
 * ── ORDER MATTERS ────────────────────────────────────────────────────────
 *
 * The document number is claimed LAST, immediately before commit. Claiming it
 * takes an exclusive lock on the sequence row that is held until commit, so
 * issuing it first would serialise every other write in the sale behind it and
 * turn a busy multi-till shop into a queue. See sequences.ts.
 *
 * ── WHAT THIS REFUSES ────────────────────────────────────────────────────
 *
 * Guards run BEFORE anything is written, so a refusal costs nothing and leaves
 * nothing behind. They are listed in finaliseGuards() rather than scattered.
 */

export type TenderInput = {
  tenderTypeId: number
  /** What the customer handed over — gross, not the amount owed. */
  amount: number
  reference?: string | null
}

export type FinaliseInput = {
  documentId: number
  tenders: TenderInput[]
  /** Required when a tender posts to an account. */
  customerId?: number | null
  /**
   * Which individual units are going out, keyed by document line id. Only
   * serial-tracked lines need it, and one is required per unit sold.
   *
   * Supplied at finalise rather than saved on the draft because the cashier
   * picks the actual box off the shelf at the moment of sale — a serial chosen
   * when the basket was built may well not be the one they hand over.
   */
  serials?: Record<number, number[]>
}

export type FinaliseResult =
  | { ok: true; documentId: number; documentNumber: string; change: number; roundingAdj: number }
  | { ok: false; error: string }

/**
 * Posts a document.
 *
 * Returns the issued number so the till can print immediately, and the change
 * so the drawer figure is never recomputed from a different rounding.
 */
export async function finaliseDocument(
  siteId: number,
  actor: Actor,
  input: FinaliseInput,
): Promise<FinaliseResult> {
  const document = await getDocument(siteId, input.documentId)
  if (!document) return { ok: false, error: 'That sale no longer exists.' }

  const guard = await finaliseGuards(siteId, document)
  if (guard) return { ok: false, error: guard }

  // Resolve every tender type up front: the engine branches on their flags, and
  // a missing one must fail before anything is written.
  const tenders: { input: TenderInput; type: TenderType }[] = []
  for (const tender of input.tenders) {
    const type = await getTenderType(siteId, tender.tenderTypeId)
    if (!type) return { ok: false, error: 'That payment method no longer exists.' }
    if (!type.isActive) return { ok: false, error: `${type.name} is not available.` }
    tenders.push({ input: tender, type })
  }
  if (tenders.length === 0) return { ok: false, error: 'Take a payment before finalising.' }

  const customerId = input.customerId ?? document.customerId ?? null

  // Recompute totals from the stored lines rather than trusting the header:
  // the header is a cache, and finalising against a stale one would post a
  // figure that does not match the lines it is made of.
  const totals = documentTotals(
    document.lines.map((line) => ({
      grossIncl: round(line.qty * line.unitPriceIncl, 2),
      discountIncl: line.discountIncl,
      lineTotalIncl: line.lineTotalIncl,
      lineTotalExcl: line.lineTotalExcl,
      lineVat: line.lineVat,
      vatRatePct: line.vatRatePct,
    })),
  )
  assertBalanced(totals)

  // 5c rounding applies to what the DRAWER takes, never to the invoice. The
  // invoice keeps its exact total so the VAT declared stays exact; the
  // difference is recorded as rounding_adj.
  const denomination = await getNumericSetting(siteId, 'sales_cash_rounding')
  const anyCash = tenders.some((t) => t.type.roundsToCashDenomination)
  const { rounded: payable, adjustment: roundingAdj } =
    anyCash && denomination > 0
      ? roundToCash(totals.totalIncl, denomination)
      : { rounded: totals.totalIncl, adjustment: 0 }

  const check = checkTenders(
    tenders.map((t) => ({ tender: t.type, amount: t.input.amount, reference: t.input.reference })),
    payable,
    customerId !== null,
  )
  if (check.errors.length > 0) return { ok: false, error: check.errors[0] }
  if (check.outstanding > 0) {
    return { ok: false, error: `${check.outstanding.toFixed(2)} still to pay.` }
  }

  // Credit check before anything is written, so an over-limit account is
  // refused at the till rather than discovered in the age analysis.
  const accountTender = tenders.find((t) => t.type.postsToDebtor)
  if (accountTender) {
    if (!customerId) return { ok: false, error: 'Choose a customer for an account sale.' }
    const refusal = await creditRefusal(siteId, customerId, accountTender.input.amount)
    if (refusal) return { ok: false, error: refusal }
  }

  // Every line must be sellable BEFORE any stock moves — a basket that fails
  // halfway would otherwise leave some products decremented.
  for (const line of document.lines) {
    const sellable = canSellNow(line.productType)
    if (!sellable.ok) return { ok: false, error: `${line.description}: ${sellable.reason}` }
  }

  // Composed products (recipe, refer) move their COMPONENTS, not themselves.
  // Resolved out here, before the transaction opens, so a half-built recipe is
  // refused while nothing has moved rather than rolling back mid-sale.
  const composed = new Map<number, ResolvedComponent[]>()
  for (const line of document.lines) {
    if (!line.productId) continue
    if (line.productType !== 'recipe' && line.productType !== 'refer') continue

    const resolved = await resolveComponents(siteId, line.productId, line.productType)
    if (!resolved.ok) return { ok: false, error: `${line.description}: ${resolved.error}` }
    composed.set(line.id, resolved.components)
  }

  // Serial-tracked lines need one identified unit per item sold, checked here
  // so a sale is refused before any stock moves rather than halfway through.
  for (const line of document.lines) {
    if (!line.productId || line.productType !== 'serial') continue

    const picked = input.serials?.[line.id] ?? []
    const needed = Math.abs(round(line.qty, 0))

    if (picked.length !== needed) {
      return {
        ok: false,
        error: `${line.description}: choose ${needed} serial number${needed === 1 ? '' : 's'} — ${picked.length} selected.`,
      }
    }
    if (new Set(picked).size !== picked.length) {
      return { ok: false, error: `${line.description}: the same serial number is selected twice.` }
    }

    const sellable = await checkSellable(siteId, line.productId, picked)
    if (!sellable.ok) return { ok: false, error: `${line.description}: ${sellable.error}` }
  }

  // Which shift banks this sale. Null when the till has no shift open, which is
  // allowed — a store that does not cash up still needs to trade.
  const shiftId = document.terminalId
    ? ((await openShiftFor(siteId, document.terminalId))?.id ?? null)
    : null

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      // 1. Stock. Direction comes from the product type, not from the sign of
      //    the quantity — a returnable puts stock IN when sold.
      for (const line of document.lines) {
        if (!line.productId) continue

        // A composed product has no pile of its own — selling a burger moves a
        // patty, a bun and a slice of cheese. Each movement names a REAL
        // product and a REAL quantity, so Σ qty_change still equals
        // stock_on_hand for every one of them.
        const components = composed.get(line.id)
        if (components) {
          for (const component of components) {
            await recordMovement(tx, actor, {
              productId: component.productId,
              movementType: line.qty > 0 ? 'sale' : 'sale_return',
              qtyChange: round(-line.qty * component.qtyPerUnit, 3),
              unitCostExcl: component.unitCostExcl,
              source: document.docType,
              sourceDocId: document.id,
              sourceLineId: line.id,
              terminalId: document.terminalId,
              shiftId,
              // Names the parent, so the component's history reads "used by"
              // rather than looking like an unexplained deduction.
              note: `${line.productCode ?? line.description} × ${component.qtyPerUnit}`.slice(0, 190),
            })
          }
          continue
        }

        const direction = stockDirectionFor(line.productType)
        if (direction === 0) continue

        await recordMovement(tx, actor, {
          productId: line.productId,
          movementType: line.qty > 0 ? 'sale' : 'sale_return',
          // qty is negative on a credit note, so multiplying by the direction
          // reverses it correctly without a second branch.
          qtyChange: round(-line.qty * -direction, 3),
          unitCostExcl: line.unitCostExcl,
          source: document.docType,
          sourceDocId: document.id,
          sourceLineId: line.id,
          terminalId: document.terminalId,
          shiftId,
          note: line.productCode ?? undefined,
        })

        // Which individual units went out. In the SAME transaction as the
        // movement, so stock and serials can never disagree about what left.
        const picked = input.serials?.[line.id]
        if (line.productType === 'serial' && picked && picked.length > 0) {
          await markSold(tx, actor, {
            serialIds: picked,
            productId: line.productId,
            documentId: document.id,
            documentLineId: line.id,
            customerId: customerId ?? document.customerId,
          })
        }
      }

      // 2. Tenders, as handed over. Change is recorded against the tender that
      //    gave it, so the drawer reconciles.
      let remainingChange = check.change
      for (const { input: tender, type } of tenders) {
        const changeHere =
          type.allowsChange && remainingChange > 0 ? Math.min(remainingChange, tender.amount) : 0
        remainingChange = round(remainingChange - changeHere, 2)

        await tx.execute(
          `INSERT INTO sales_tenders
             (document_id, tender_type_id, tender_code, tender_name, amount, change_given, surcharge, reference)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            document.id,
            type.id,
            type.code,
            type.name,
            round(tender.amount, 2).toFixed(4),
            changeHere.toFixed(4),
            type.surchargePct > 0
              ? round(tender.amount * (type.surchargePct / 100), 2).toFixed(4)
              : '0.0000',
            tender.reference?.trim() || null,
          ] as never,
        )
      }

      // 3. The number, LAST. See the module comment on lock ordering.
      const documentNumber = await nextDocumentNumber(tx, document.docType)

      await tx.execute(
        `UPDATE sales_documents SET
           status = 'finalised', document_number = ?, finalised_at = NOW(),
           customer_id = ?, shift_id = ?, subtotal_excl = ?, vat_total = ?, discount_total = ?,
           total_incl = ?, rounding_adj = ?, tendered_total = ?, change_given = ?
         WHERE id = ?`,
        [
          documentNumber,
          customerId,
          // Stamped at finalise rather than at capture: a sale belongs to the
          // shift that BANKED it, and a parked basket may be recalled by the
          // next person on the till.
          shiftId,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.discountTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          roundingAdj.toFixed(4),
          check.tendered.toFixed(4),
          check.change.toFixed(4),
          document.id,
        ] as never,
      )

      await tx.execute(
        `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, 'finalised', ?, ?, ?)`,
        [
          document.id,
          `${documentNumber} · ${totals.totalIncl.toFixed(2)} · ${tenders.map((t) => t.type.name).join(', ')}`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )

      return { documentNumber }
    })

    // 4. The debtor ledger, AFTER the sale is safely committed.
    //
    // Deliberately outside the transaction: the ledger lives in its own
    // consistent world with its own invariant, and a failure to post there must
    // not un-sell goods that have already left the shop. A missing ledger entry
    // is visible on the account and fixable; an un-posted sale with stock gone
    // is not.
    if (accountTender && customerId) {
      await postTransaction(siteId, actor, {
        customerId,
        // THE BOUNDARY. A sales-side `credit_sale` posts to the ledger as a
        // `credit_note`, because on an account that is what it is: a credit
        // adjustment against the balance. Same event, two vocabularies, and
        // this line is where one becomes the other.
        docType: document.docType === 'credit_sale' ? 'credit_note' : 'invoice',
        amount: Math.abs(accountTender.input.amount),
        docDate: document.documentDate,
        docNumber: posted.documentNumber,
        description: `${document.docLabel} ${posted.documentNumber}`,
        source: 'sale',
        sourceDocId: document.id,
      })
    }

    return {
      ok: true,
      documentId: document.id,
      documentNumber: posted.documentNumber,
      change: check.change,
      roundingAdj,
    }
  } catch (error) {
    // The transaction has rolled back, so no stock moved and no number was
    // consumed. Surface the reason rather than a generic failure — at a till,
    // "something went wrong" is unactionable.
    const message = error instanceof Error ? error.message : 'The sale could not be posted.'
    return { ok: false, error: message }
  }
}

/** Everything that stops a document being posted. Runs before any write. */
async function finaliseGuards(siteId: number, document: SalesDocument): Promise<string | null> {
  if (!isEditable(document.status)) {
    return document.status === 'finalised'
      ? `This sale was already finalised as ${document.documentNumber}.`
      : `A ${document.status} document cannot be finalised.`
  }
  if (document.lines.length === 0) return 'Add at least one line before finalising.'

  // A quote or an order is not a tax document; converting it creates a linked
  // invoice rather than posting the quote itself.
  if (document.docType === 'quote' || document.docType === 'sales_order') {
    return `A ${document.docLabel.toLowerCase()} is not posted — convert it to an invoice.`
  }

  if (await isPeriodLocked(siteId, document.documentDate)) {
    return `The VAT period covering ${document.documentDate} is locked. Date the sale today instead.`
  }

  // A deactivated till stops working on its next sale, not at the next sign-in.
  if (document.terminalId) {
    const terminal = await validateTerminalClaim(siteId, document.terminalId)
    if (!terminal) return 'This till is no longer registered. Re-register it in Setup → Tills.'
  }

  return null
}

/**
 * Why this account cannot take this amount on credit. Null means it can.
 *
 * Re-checked here even though the till already asked: a basket can sit on
 * screen for ten minutes while someone else settles — or exhausts — the same
 * account. The RULES come from lib/creditRules.ts, so this and the till cannot
 * reach different conclusions; only the freshness of the balance differs, and
 * this one is authoritative.
 */
async function creditRefusal(
  siteId: number,
  customerId: number,
  amount: number,
): Promise<string | null> {
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT name, status, account_type, credit_limit, balance FROM customers WHERE id = ? LIMIT 1',
    [customerId],
  )
  if (!row) return 'That customer no longer exists.'

  return headroomRefusal(
    {
      name: String(row.name),
      status: String(row.status),
      accountType: toAccountType(row.account_type),
      creditLimit: toNum(row.credit_limit),
      balance: toNum(row.balance),
    },
    amount,
  )
}

/* ── Void ────────────────────────────────────────────────────────────────── */

export type VoidResult = { ok: true } | { ok: false; error: string }

/**
 * Voids a finalised document — same trading day only.
 *
 * Keeps its number and all its lines. A void is not a deletion: the number must
 * still resolve to a document, with a stated reason, or the sequence has an
 * unexplainable hole in it.
 *
 * Cross-day voids are refused deliberately. A void changes a period's reported
 * figures, and after the day is banked that period may already have been
 * reported on. The instrument for a later correction is a credit note.
 */
export async function voidDocument(
  siteId: number,
  actor: Actor,
  documentId: number,
  reason: string,
): Promise<VoidResult> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for the void.' }

  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That document no longer exists.' }
  if (document.status === 'cancelled') return { ok: false, error: 'That document is already void.' }
  if (document.status !== 'finalised') {
    return { ok: false, error: 'Only a finalised document can be voided.' }
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  if (document.documentDate !== todayStr) {
    return {
      ok: false,
      error: `${document.documentNumber} was issued on ${document.documentDate}. Raise a credit note instead — voiding it would change a day that has already been banked.`,
    }
  }

  if (await isPeriodLocked(siteId, document.documentDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  // An ACCOUNT sale put a debit on the customer's card. Voiding the sale
  // without reversing that debit would leave them owing money for goods that
  // came back — wrong on the balance, the statement and the age analysis
  // alike. Found and located BEFORE any stock moves, because the reversal can
  // legitimately refuse (a payment already allocated against it), and
  // discovering that after the stock is back is too late to do anything about.
  const ledgerEntry = document.customerId
    ? await findSaleTransaction(siteId, document.customerId, document.id)
    : null

  if (ledgerEntry) {
    const reversal = await reverseTransaction(
      siteId,
      actor,
      ledgerEntry,
      `Void of ${document.documentNumber}: ${reason.trim()}`,
    )
    if (!reversal.ok) {
      return {
        ok: false,
        error: `${document.documentNumber} cannot be voided: ${reversal.error}`,
      }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    // Reversing movements. The originals stay — an audit row is never deleted.
    for (const line of document.lines) {
      if (!line.productId) continue
      const direction = stockDirectionFor(line.productType)
      if (direction === 0) continue

      await recordMovement(tx, actor, {
        productId: line.productId,
        movementType: 'sale_return',
        qtyChange: round(line.qty * -direction, 3),
        unitCostExcl: line.unitCostExcl,
        source: 'cancelled',
        sourceDocId: document.id,
        sourceLineId: line.id,
        terminalId: document.terminalId,
        note: `Void of ${document.documentNumber}`,
      })
    }

    // Serial-tracked units go back on the shelf as sellable. The stock movement
    // above already returned the quantity; without this the individual units
    // would stay marked 'sold' and reconcileSerials would report drift for a
    // sale that never happened.
    //
    // Resellable without asking, unlike a credit note: a void means the sale
    // never happened, so the goods never left and there is nothing to inspect.
    //
    // location_id has to come back with the status. markSold clears it — a sold
    // unit is in no room — so restoring 'in_stock' without a room would leave a
    // sellable unit sitting nowhere, which the per-location reconciliation
    // reports as drift and which no picking list could find.
    //
    // The room it LEFT is on its own 'sold' movement. Falling back to main
    // covers a unit sold before locations existed, whose history predates the
    // column.
    await tx.execute(
      `UPDATE product_serials s
          SET s.status = 'in_stock', s.sold_doc_id = NULL, s.sold_line_id = NULL,
              s.sold_at = NULL, s.customer_id = NULL,
              s.location_id = COALESCE(
                (SELECT sm.from_location_id
                   FROM serial_movements sm
                  WHERE sm.serial_id = s.id AND sm.action = 'sold'
                    AND sm.document_id = ?
                    AND sm.from_location_id IS NOT NULL
                  ORDER BY sm.id DESC LIMIT 1),
                (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1)
              )
        WHERE s.sold_doc_id = ? AND s.status = 'sold'`,
      [document.id, document.id] as never,
    )

    await tx.execute(
      `INSERT INTO serial_movements (serial_id, action, document_id, user_id, user_name, note)
       SELECT id, 'returned', ?, ?, ?, ?
         FROM product_serials WHERE sold_doc_id IS NULL AND id IN (
           SELECT serial_id FROM serial_movements
            WHERE document_id = ? AND action = 'sold'
         )`,
      [
        document.id,
        actor.userId,
        actor.userName.slice(0, 120),
        `Void of ${document.documentNumber}`,
        document.id,
      ] as never,
    )

    await tx.execute(
      `UPDATE sales_documents
          SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW(), cancelled_by_user_id = ?
        WHERE id = ?`,
      [reason.trim().slice(0, 190), actor.userId, document.id] as never,
    )

    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'cancelled', ?, ?, ?)`,
      [document.id, reason.trim().slice(0, 400), actor.userId, actor.userName.slice(0, 120)] as never,
    )
  })

  return { ok: true }
}

/**
 * The ledger entry a sale posted, if it was an account sale.
 *
 * Matched on `source_doc_id` rather than the document number, because the
 * number is a display string that a correction or an import could legitimately
 * repeat, while the source link is the actual relationship.
 *
 * Ignores an entry that has already been reversed, so voiding is not blocked
 * by its own earlier reversal in a retry.
 */
async function findSaleTransaction(
  siteId: number,
  customerId: number,
  documentId: number,
): Promise<number | null> {
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT t.id
       FROM customer_transactions t
      WHERE t.customer_id = ? AND t.source_doc_id = ? AND t.source = 'sale'
        AND NOT EXISTS (
          SELECT 1 FROM customer_transactions r WHERE r.reverses_id = t.id
        )
      ORDER BY t.id DESC LIMIT 1`,
    [customerId, documentId],
  )
  return row ? Number(row.id) : null
}

/** Bumps the reprint counter. Some jurisdictions require reprints marked COPY. */
export async function recordPrint(siteId: number, documentId: number): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      'UPDATE sales_documents SET print_count = print_count + 1, last_printed_at = NOW() WHERE id = ?',
      [documentId] as never,
    )
  })
}

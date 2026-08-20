import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { assertBalanced, documentTotals, lineTotals } from '../documentMath'
import { nextDocumentNumber } from './sequences'
import { recordMovement, stockDirectionFor } from './stockMovements'
import { terminalStockLocationId } from './terminals'
import { getTenderType } from './tenderTypes'
import { guardPosting } from './periodLocks'
import { getDocument, todayIso, type SalesDocument } from './salesDocuments'
import { resolveComponents, explodingProducts, type ResolvedComponent } from './productComposition'
import type { ProductTypeId } from '../productTypes'
import { postTransaction } from './customerLedger'
import { requireSalesReason } from './salesReasons'
import type { Actor } from './activityLog'

/**
 * Credit notes — undoing a sale after the day it was rung up.
 *
 * A VOID (salesPosting.ts) says the sale should never have existed, and is only
 * possible on the trading day it happened. A CREDIT NOTE says the sale was real
 * but something came back or was overcharged, and is the correct instrument
 * once the day has been banked. SARS treats them differently, and so does this
 * module.
 *
 * ── WHAT A CREDIT NOTE IS ────────────────────────────────────────────────
 *
 * Its own document, with its own number from the CRN sequence, linked to the
 * invoice through `reverses_id`. NOT an edit of the original: the customer may
 * be holding a printed copy of that invoice, and it must keep saying what it
 * said.
 *
 * ── THE COST RULE ────────────────────────────────────────────────────────
 *
 * `unit_cost_excl` is COPIED FROM THE ORIGINAL LINE, never re-read from the
 * product. Returning an item at today's higher cost would manufacture margin
 * that was never earned, and the GP report would quietly drift every time
 * prices moved.
 */

export type CreditLineInput = {
  /** The invoice line being credited. Omit for a no-receipt return. */
  sourceLineId?: number | null
  productId?: number | null
  productCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  /** Positive here; stored negative. The caller says "credit 2", not "credit −2". */
  qty: number
  unitPriceIncl: number
  vatRatePct: number
  unitCostExcl: number
}

export type CreditNoteInput = {
  /** The invoice being credited. Null for a return with no receipt. */
  invoiceId: number | null
  customerId?: number | null
  customerName?: string | null
  /**
   * Which of the shop's return reasons this is. Required, and what every
   * report groups by.
   */
  reasonId: number
  /**
   * The detail that never fits a code. Optional, and only offered by the till
   * for reasons whose `allowsNote` says the code does not speak for itself.
   */
  note?: string | null
  /**
   * A caption prefixed to the stored text — "No receipt", say. The reason
   * itself is the code, so this carries only what the code cannot.
   */
  reasonPrefix?: string | null
  /**
   * Accepts a retired reason. Only for the paths where the SYSTEM chose the
   * code rather than a person — an invoice correction must not start failing
   * because a site tidied its returns list.
   */
  allowRetiredReason?: boolean
  lines: CreditLineInput[]
  terminalId?: number | null
  terminalCode?: string | null
  /** Refund tenders. Omit to leave the credit sitting on the account. */
  refunds?: { tenderTypeId: number; amount: number; reference?: string | null }[]
}

export type CreditNoteResult =
  | { ok: true; documentId: number; documentNumber: string; total: number }
  | { ok: false; error: string }

/**
 * How much of each line has already been credited.
 *
 * Summed across every credit note pointing at this invoice, so crediting the
 * same line twice cannot exceed what was sold. Keyed by the ORIGINAL line id,
 * which is why credit lines carry `sourceLineId`.
 */
export async function creditedQtyByLine(
  siteId: number,
  invoiceId: number,
): Promise<Map<number, number>> {
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT l.product_id, l.description, SUM(ABS(l.qty)) AS credited
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
      WHERE d.reverses_id = ? AND d.doc_type = 'credit_sale' AND d.status = 'finalised'
      GROUP BY l.product_id, l.description`,
    [invoiceId],
  )

  // Matched on product + description rather than a stored line link: a
  // free-text line has no product id, and the pair is unique enough on one
  // invoice for this purpose.
  const byKey = new Map<string, number>()
  for (const row of rows) {
    byKey.set(`${row.product_id ?? 'free'}::${row.description}`, toNum(row.credited))
  }

  const invoice = await getDocument(siteId, invoiceId)
  const byLine = new Map<number, number>()
  if (!invoice) return byLine

  for (const line of invoice.lines) {
    byLine.set(line.id, byKey.get(`${line.productId ?? 'free'}::${line.description}`) ?? 0)
  }
  return byLine
}

/** What may still be credited on each line of an invoice. */
export async function creditableLines(siteId: number, invoiceId: number) {
  const [invoice, credited] = await Promise.all([
    getDocument(siteId, invoiceId),
    creditedQtyByLine(siteId, invoiceId),
  ])
  if (!invoice) return null

  return invoice.lines.map((line) => {
    const already = credited.get(line.id) ?? 0
    return {
      ...line,
      alreadyCredited: already,
      creditable: round(Math.max(Math.abs(line.qty) - already, 0), 3),
    }
  })
}

export async function createCreditNote(
  siteId: number,
  actor: Actor,
  input: CreditNoteInput,
): Promise<CreditNoteResult> {
  // Resolved before anything else: the id came from a client — a till, a form,
  // or an offline payload replayed hours later — and one from the void list
  // would satisfy the foreign key while labelling the return with the wrong
  // vocabulary.
  const chosen = await requireSalesReason(
    siteId,
    'return',
    input.reasonId,
    input.allowRetiredReason === true,
  )
  if (!chosen.ok) return { ok: false, error: chosen.error }
  if (input.lines.length === 0) return { ok: false, error: 'Choose at least one line to credit.' }

  // What a person reads on the ledger, the audit row and the credit note. The
  // code alone is terse and the note alone loses the grouping, so the stored
  // text is both — which is also what keeps internal_note meaningful for every
  // reader that predates the codes.
  const note = input.note?.trim() ?? ''
  const prefix = input.reasonPrefix?.trim() ?? ''
  const reason = [prefix ? `${prefix}:` : '', chosen.reason.name, note ? `— ${note}` : '']
    .filter(Boolean)
    .join(' ')

  let invoice: SalesDocument | null = null

  if (input.invoiceId) {
    invoice = await getDocument(siteId, input.invoiceId)
    if (!invoice) return { ok: false, error: 'That invoice no longer exists.' }
    if (invoice.status !== 'finalised') {
      return { ok: false, error: `A ${invoice.status} document cannot be credited.` }
    }
    if (invoice.docType !== 'invoice') {
      return { ok: false, error: 'Only an invoice can be credited.' }
    }

    // Guard against crediting more than was sold, across ALL credit notes on
    // this invoice — not just this one.
    const credited = await creditedQtyByLine(siteId, input.invoiceId)
    for (const line of input.lines) {
      if (!line.sourceLineId) continue
      const original = invoice.lines.find((l) => l.id === line.sourceLineId)
      if (!original) return { ok: false, error: `A line on that invoice no longer exists.` }

      const already = credited.get(original.id) ?? 0
      const remaining = round(Math.abs(original.qty) - already, 3)
      if (line.qty > remaining + 0.0005) {
        return {
          ok: false,
          error: `${original.description}: only ${remaining} left to credit (${already} already credited of ${Math.abs(original.qty)}).`,
        }
      }
    }
  }

  for (const line of input.lines) {
    if (line.qty <= 0) return { ok: false, error: `${line.description}: enter a quantity to credit.` }
  }

  // Who to charge the clawback to, per original line. Empty for a return with
  // no receipt, which reverses nothing in particular and so belongs to nobody.
  const originalById = new Map(
    (invoice?.lines ?? []).map((l) => [
      l.id,
      { salesRepId: l.salesRepId, salesRepUserId: l.salesRepUserId },
    ]),
  )

  // The period lock is the only thing standing between a correction and a
  // restated VAT return. Dated today, so a locked PAST period does not block a
  // credit raised now — that is the whole point of crediting rather than
  // voiding.
  const docDate = todayIso()
  const lockRefusal = await guardPosting(siteId, docDate, 'sales')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  const customerId = input.customerId ?? invoice?.customerId ?? null

  // Negative throughout — the sign convention from 015_sales_core.sql. Every
  // aggregate is then a plain SUM with no CASE on doc_type.
  const computed = input.lines.map((line) => ({
    ...lineTotals({
      qty: -Math.abs(line.qty),
      unitPriceIncl: line.unitPriceIncl,
      vatRatePct: line.vatRatePct,
    }),
    vatRatePct: line.vatRatePct,
  }))
  const totals = documentTotals(computed)
  assertBalanced(totals)

  // Refunds, if money is going back out now.
  const refunds: { amount: number; reference?: string | null; type: Awaited<ReturnType<typeof getTenderType>> }[] = []
  for (const refund of input.refunds ?? []) {
    const type = await getTenderType(siteId, refund.tenderTypeId)
    if (!type) return { ok: false, error: 'That payment method no longer exists.' }
    if (!type.allowsRefund) {
      return {
        ok: false,
        error: `${type.name} cannot be refunded at the till — pay it back through the bank instead.`,
      }
    }
    refunds.push({ amount: refund.amount, reference: refund.reference, type })
  }

  const refundTotal = refunds.reduce((sum, r) => round(sum + r.amount, 2), 0)
  if (refundTotal > Math.abs(totals.totalIncl) + 0.005) {
    return { ok: false, error: 'The refund is more than the credit note is worth.' }
  }

  // Composed products return their COMPONENTS, exactly as selling them consumed
  // components. Resolved before the transaction opens, so a recipe that has
  // since been unpicked fails before anything is written.
  //
  // A MANUFACTURED recipe is excluded, and must be: the sale took the finished
  // unit off its own pile, so the credit note has to put that unit back. Giving
  // the ingredients back instead would create stock out of nothing and leave
  // the finished pile short. This is the same set the sale used — one
  // definition, so the two can never disagree.
  const exploding = await explodingProducts(
    siteId,
    input.lines.filter((l) => l.productId).map((l) => l.productId as number),
  )

  const composed = new Map<number, ResolvedComponent[]>()
  for (const [index, line] of input.lines.entries()) {
    if (!line.productId) continue
    const type = (line.productType ?? 'normal') as ProductTypeId
    if (type !== 'recipe' && type !== 'refer') continue
    if (!exploding.has(line.productId)) continue

    const resolved = await resolveComponents(siteId, line.productId, type)
    if (!resolved.ok) return { ok: false, error: `${line.description}: ${resolved.error}` }
    composed.set(index, resolved.components)
  }

  /*
   * Which room the goods come back INTO: the one the returning till sells from.
   *
   * ── WHY THIS IS THE TILL'S ROOM AND NOT THE ORIGINAL SALE'S ──────────────
   *
   * A void takes the opposite rule — it reverses into the room the goods LEFT,
   * because a void says the sale never happened and the stock never moved. A
   * credit note is the other thing entirely: the customer is standing at a
   * counter physically handing goods over, and those goods are now in THAT
   * room. Putting them back where they were sold from would credit the shop
   * floor for a box the trade hatch is holding, and no transfer would ever say
   * how it crossed.
   *
   * It also has to work for a no-receipt return, where there is no original
   * sale to read a room off at all.
   *
   * Null — a back-office credit with no till — falls through to main, exactly
   * as it always has.
   */
  const returnLocationId = await terminalStockLocationId(siteId, input.terminalId)

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      const [res] = await tx.execute(
        `INSERT INTO sales_documents
           (doc_type, status, document_date, customer_id, customer_name, customer_vat_no,
            user_id, user_name, terminal_id, terminal_code, reverses_id,
            subtotal_excl, vat_total, discount_total, total_incl, notes, internal_note,
            return_reason_id)
         VALUES ('credit_sale','finalised',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          docDate,
          customerId,
          input.customerName ?? invoice?.customerName ?? 'Walk-in',
          invoice?.customerVatNo ?? null,
          actor.userId,
          actor.userName.slice(0, 120),
          input.terminalId ?? null,
          input.terminalCode ?? null,
          input.invoiceId,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.discountTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          invoice ? `Credit of ${invoice.documentNumber}` : 'Return without a receipt',
          reason.slice(0, 400),
          chosen.reason.id,
        ] as never,
      )
      const documentId = (res as { insertId: number }).insertId

      for (const [index, line] of input.lines.entries()) {
        const c = computed[index]
        await tx.execute(
          // source_line_id and sales_rep_user_id are carried across from the
          // invoice line being reversed (043). Without them a clawback lands on
          // whoever processed the refund rather than on the person who made the
          // sale, and the refund desk slowly absorbs everybody else's negatives.
          `INSERT INTO sales_document_lines
             (document_id, line_number, product_id, product_code, description, product_type,
              department_id, source_line_id, sales_rep_id, sales_rep_user_id,
              qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
              line_total_incl, line_total_excl, line_vat, unit_cost_excl)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?)`,
          [
            documentId,
            index + 1,
            line.productId ?? null,
            line.productCode ?? null,
            line.description.slice(0, 190),
            line.productType ?? 'normal',
            line.departmentId ?? null,
            line.sourceLineId ?? null,
            originalById.get(line.sourceLineId ?? 0)?.salesRepId ?? null,
            originalById.get(line.sourceLineId ?? 0)?.salesRepUserId ?? null,
            round(-Math.abs(line.qty), 3).toFixed(3),
            round(line.unitPriceIncl, 4).toFixed(4),
            line.vatRatePct.toFixed(3),
            c.lineTotalIncl.toFixed(4),
            c.lineTotalExcl.toFixed(4),
            c.lineVat.toFixed(4),
            // Copied from the original line by the caller. Re-reading the
            // product here would manufacture margin at today's cost.
            line.unitCostExcl.toFixed(4),
          ] as never,
        )

        // Stock comes back in. Direction is flipped from the sale: a normal
        // product returns TO the shelf, a returnable leaves it again.
        if (line.productId) {
          // A composed product has no pile of its own, so what comes back is
          // its components — the mirror of what selling it consumed. Without
          // this the credit would return NOTHING and the ingredients would
          // stay written off.
          const components = composed.get(index)
          if (components) {
            for (const component of components) {
              await recordMovement(tx, actor, {
                productId: component.productId,
                movementType: 'sale_return',
                qtyChange: round(Math.abs(line.qty) * component.qtyPerUnit, 3),
                unitCostExcl: component.unitCostExcl,
                source: 'credit_sale',
                sourceDocId: documentId,
                terminalId: input.terminalId ?? null,
                locationId: returnLocationId,
                note: `${line.productCode ?? line.description} × ${component.qtyPerUnit}`.slice(0, 190),
              })
            }
          } else {
            const type = (line.productType ?? 'normal') as ProductTypeId
            // Carries a pile of its own: a manufactured recipe, or a
            // normal-method refer. Either way the PACK comes back, not its
            // contents — and a returned case is never re-closed, because the
            // shop cannot un-open one. See referBreakdown.ts.
            const direction = stockDirectionFor(
              type,
              (type === 'recipe' || type === 'refer') && !exploding.has(line.productId),
            )
            if (direction !== 0) {
              await recordMovement(tx, actor, {
                productId: line.productId,
                movementType: 'sale_return',
                qtyChange: round(Math.abs(line.qty) * -direction, 3),
                unitCostExcl: line.unitCostExcl,
                source: 'credit_sale',
                sourceDocId: documentId,
                terminalId: input.terminalId ?? null,
                locationId: returnLocationId,
                note: invoice ? `Credit of ${invoice.documentNumber}` : 'No-receipt return',
                // A receipted batch return goes back to the lots the ORIGINAL
                // line took (148); a no-receipt return falls to the newest lot.
                batch: { returnOfLineId: line.sourceLineId ?? null },
              })
            }
          }
        }
      }

      for (const refund of refunds) {
        await tx.execute(
          `INSERT INTO sales_tenders
             (document_id, tender_type_id, tender_code, tender_name, amount, change_given, surcharge, reference)
           VALUES (?,?,?,?,?,0,0,?)`,
          [
            documentId,
            refund.type!.id,
            refund.type!.code,
            refund.type!.name,
            // Negative: money leaving the drawer, so the cash-up nets correctly.
            round(-Math.abs(refund.amount), 2).toFixed(4),
            refund.reference?.trim() || null,
          ] as never,
        )
      }

      // The number LAST, for the same lock-ordering reason as a sale.
      const documentNumber = await nextDocumentNumber(tx, 'credit_sale')
      await tx.execute(
        'UPDATE sales_documents SET document_number = ?, finalised_at = NOW() WHERE id = ?',
        [documentNumber, documentId] as never,
      )

      await tx.execute(
        `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, 'credit_sale', ?, ?, ?)`,
        [
          documentId,
          `${documentNumber} · ${totals.totalIncl.toFixed(2)}${invoice ? ` · credits ${invoice.documentNumber}` : ' · no receipt'} · ${reason}`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )

      return { documentId, documentNumber }
    })

    // The ledger, after the document is safely committed — same reasoning as a
    // sale. Only the part NOT refunded in cash reduces what they owe.
    if (customerId) {
      const onAccount = round(Math.abs(totals.totalIncl) - refundTotal, 2)
      if (onAccount > 0) {
        await postTransaction(siteId, actor, {
          customerId,
          // Ledger vocabulary, not sales vocabulary — see the note in
          // salesPosting.ts. On the account this is a credit note.
          docType: 'credit_note',
          amount: onAccount,
          docDate,
          docNumber: posted.documentNumber,
          description: invoice
            ? `Credit of ${invoice.documentNumber} — ${reason}`
            : `Credit note — ${reason}`,
          source: 'sale',
          sourceDocId: posted.documentId,
          // Applies to the oldest open invoice unless someone allocates it by
          // hand, which is what a customer expects a credit to do.
          autoAllocate: true,
        })
      }
    }

    return {
      ok: true,
      documentId: posted.documentId,
      documentNumber: posted.documentNumber,
      total: Math.abs(totals.totalIncl),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The credit note could not be posted.'
    return { ok: false, error: message }
  }
}

/** Credit notes raised against an invoice, for its detail screen. */
export async function creditNotesFor(siteId: number, invoiceId: number) {
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT id, document_number, document_date, total_incl, internal_note
       FROM sales_documents
      WHERE reverses_id = ? AND doc_type = 'credit_sale'
      ORDER BY id`,
    [invoiceId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date),
    total: toNum(r.total_incl),
    reason: (r.internal_note as string | null) ?? null,
  }))
}

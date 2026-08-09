import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteTransaction } from '../siteDb'
import { round } from '../decimals'
import { isPeriodLocked } from './settings'
import { capabilitiesForRole } from './permissions'
import { checkPricing } from './priceGuard'
import { saveDraft, getDocument, type LineInput } from './salesDocuments'
import { finaliseDocument } from './salesPosting'
import type { OfflineSale, SyncSaleResult } from '../posOffline/types'

/**
 * Posting a sale that was rung up while the till had no database.
 *
 * ── THE ONE RULE THAT SHAPES EVERYTHING HERE ──────────────────────────────
 *
 * An offline sale is ALWAYS POSTED. By the time this runs, the customer has the
 * goods, the drawer has the cash and a printed tax invoice bearing a specific
 * number is in somebody's pocket. A server that "refuses" such a sale does not
 * undo it — it loses it, and with it the revenue and the VAT. The stock has left
 * the shop either way.
 *
 * So every figure is recomputed server-side, and every disagreement between what
 * the till charged and what the server says it should have charged is written onto
 * the document as an EXCEPTION for a manager to look at. The server's figure is
 * what posts. Because the till computed its totals with the same pure modules the
 * server uses (documentMath, tenderMath, specialsEngine), that exception column is
 * empty in the normal case — it is a real disagreement when it is set, not noise.
 *
 * Four things are exceptions to the rule, and only because posting them corrupts
 * something that cannot be put back:
 *
 *   · A LOCKED VAT PERIOD. Posting into a submitted return silently changes a
 *     figure already declared to SARS. The sale is QUARANTINED instead — saved as
 *     a draft, with the reason on it, visible on the exceptions screen. Not lost;
 *     just not posted until a human decides how.
 *   · AN ALREADY-POSTED uid. Not a refusal at all — that is idempotency working.
 *     The number already issued is returned and nothing is written twice.
 *   · A STRUCTURALLY INVALID PAYLOAD. A bug or an attack, not a sale. Refused
 *     non-retryably so the queue drains and the till can say so.
 *   · A PRODUCT THAT NO LONGER EXISTS. The line still posts, with product_id
 *     NULL, keeping its description and price so the money is right. Stock cannot
 *     move for a product that is gone.
 *
 * ── THERE IS NO SECOND POSTING PATH ───────────────────────────────────────
 *
 * This goes saveDraft → checkPricing → finaliseDocument: the exact path an online
 * sale takes. Nothing about money is reimplemented here. What this module adds is
 * only the claim, the classification and the audit trail.
 */

/* ── Structural validation ───────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Refuses a payload that cannot be a sale, or null.
 *
 * Deliberately structural only — shape, finiteness, bounds. It must never refuse
 * on a business judgement (a price that looks wrong, a discount that looks
 * generous): those are exceptions to be recorded, per the rule above. Anything
 * this function refuses is a bug or an attack, and retrying it forever would be a
 * queue that never drains with a cashier who never finds out.
 */
export function validateOfflineSale(sale: OfflineSale): string | null {
  if (!sale || typeof sale !== 'object') return 'Not a sale.'
  if (!UUID.test(sale.saleUid ?? '')) return 'Missing or malformed sale uid.'
  if (!sale.documentNumber?.trim()) return 'A sale rung up offline must carry its printed number.'
  if (sale.documentNumber.length > 32) return 'That document number is too long.'
  if (!ISO_DATE.test(sale.documentDate ?? '')) return 'Missing or malformed document date.'
  if (!Number.isFinite(Date.parse(sale.takenAt ?? ''))) return 'Missing or malformed taken-at time.'

  if (!Array.isArray(sale.lines) || sale.lines.length === 0) return 'A sale must have lines.'
  if (sale.lines.length > 500) return 'A sale cannot have more than 500 lines.'
  for (const [i, line] of sale.lines.entries()) {
    const where = `Line ${i + 1}`
    if (!line.description?.trim()) return `${where}: no description.`
    // Zero is refused as well as non-finite: a zero-qty line contributes nothing
    // and is only ever a client bug.
    if (!Number.isFinite(line.qty) || line.qty <= 0) return `${where}: bad quantity.`
    if (!Number.isFinite(line.unitPriceIncl) || line.unitPriceIncl < 0) return `${where}: bad price.`
    if (!Number.isFinite(line.discountPct) || line.discountPct < 0 || line.discountPct > 100) {
      return `${where}: bad discount.`
    }
    if (!Number.isFinite(line.vatRatePct) || line.vatRatePct < 0 || line.vatRatePct > 100) {
      return `${where}: bad VAT rate.`
    }
  }

  if (!Array.isArray(sale.tenders) || sale.tenders.length === 0) return 'A sale must have a payment.'
  if (sale.tenders.length > 20) return 'Too many payments on one sale.'
  for (const tender of sale.tenders) {
    if (!Number.isInteger(tender.tenderTypeId) || tender.tenderTypeId <= 0) {
      return 'Bad payment method.'
    }
    if (!Number.isFinite(tender.amount) || tender.amount < 0) return 'Bad payment amount.'
  }

  for (const claimed of [sale.claimedTotalIncl, sale.claimedTenderedTotal, sale.claimedChange]) {
    if (!Number.isFinite(claimed)) return 'Bad claimed total.'
  }
  return null
}

/* ── The claim ───────────────────────────────────────────────────────────── */

type ClaimRow = RowDataPacket & {
  status: 'claimed' | 'posted' | 'rejected'
  document_id: number | null
  document_number: string | null
  error: string | null
}

/**
 * Takes the uid, or reports that somebody already has it.
 *
 * One INSERT … ON DUPLICATE KEY either wins the claim or discovers the sale is
 * already ours — no read-then-write race, which matters because a till WILL send
 * the same batch twice: "the request timed out" and "the request succeeded and the
 * response was lost" are indistinguishable from a shop counter.
 *
 * `attempts` is incremented on the duplicate branch, so the exceptions screen can
 * show a sale that has been failing repeatedly rather than only its last error.
 */
async function claim(
  siteId: number,
  sale: OfflineSale,
): Promise<{ fresh: boolean; row: ClaimRow }> {
  await siteQueryOne(
    siteId,
    `INSERT INTO offline_sync_claims (sale_uid, terminal_id, operator_name, attempts)
     VALUES (?,?,?,1)
     ON DUPLICATE KEY UPDATE attempts = attempts + 1`,
    [sale.saleUid, sale.terminalId ?? null, (sale.operatorName ?? '').slice(0, 120)],
  ).catch(() => null)

  const row = await siteQueryOne<ClaimRow>(
    siteId,
    `SELECT status, document_id, document_number, error, attempts
       FROM offline_sync_claims WHERE sale_uid = ?`,
    [sale.saleUid],
  )
  if (!row) throw new Error('The sync claim could not be read back.')
  return { fresh: (row as ClaimRow & { attempts: number }).attempts <= 1, row }
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

/**
 * Whether a throw is another request having claimed this uid first.
 *
 * Matched on the index NAME rather than only the error code: `ER_DUP_ENTRY` also
 * covers a colliding document_number, and those two need opposite responses — a
 * duplicate uid is the safety net working, while a duplicate document number is a
 * genuine numbering collision that must not be reported as harmless.
 */
function isDuplicateUid(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  return e?.code === 'ER_DUP_ENTRY' && /uq_offline_uid/.test(e?.message ?? '')
}

/** Joins exception reasons into the one 400-char column, in the order found. */
function exceptionText(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null
  return reasons.join(' · ').slice(0, 400)
}

/**
 * Posts one offline sale, idempotently.
 *
 * Returns a per-sale result rather than throwing, because a batch of 25 must not
 * lose 24 good sales to one bad one. `retryable` tells the till whether to keep
 * the entry: false means a human has to look at it, and the till stops burning
 * the battery on it.
 */
export async function postOfflineSale(
  siteId: number,
  sale: OfflineSale,
): Promise<SyncSaleResult> {
  /* 1. Structure. Before the claim: a malformed payload must not consume a uid. */
  const invalid = validateOfflineSale(sale)
  if (invalid) return { saleUid: sale?.saleUid ?? '', ok: false, error: invalid, retryable: false }

  /* 2. Claim, and handle every way this uid might already be known. */
  const { row } = await claim(siteId, sale)

  if (row.status === 'posted') {
    // Idempotency working exactly as intended. Nothing is written again.
    return {
      saleUid: sale.saleUid,
      ok: true,
      duplicate: true,
      documentNumber: row.document_number ?? undefined,
      documentId: row.document_id ?? undefined,
    }
  }
  if (row.status === 'rejected') {
    return { saleUid: sale.saleUid, ok: false, error: row.error ?? 'Refused.', retryable: false }
  }
  if (row.document_id) {
    /*
     * A claim stuck at `claimed` WITH a document id is the crash window this
     * design knowingly leaves open: finaliseDocument commits, and the claim
     * update commits separately (getting both into one transaction would mean
     * threading an outer connection through the most sensitive function in the
     * codebase). If that document did finalise, the sale is on the books and the
     * only thing missing is the claim's own bookkeeping — so complete it rather
     * than posting a second copy.
     */
    const existing = await getDocument(siteId, row.document_id)
    if (existing && existing.status === 'finalised') {
      await settleClaim(siteId, sale, existing.id, existing.documentNumber ?? '', null)
      return {
        saleUid: sale.saleUid,
        ok: true,
        duplicate: true,
        documentNumber: existing.documentNumber ?? undefined,
        documentId: existing.id,
      }
    }
    // It did not finalise, so nothing was written that matters. Fall through and
    // post it properly.
  }

  const reasons: string[] = []

  /* 3. The operator, resolved SERVER-SIDE. The payload's name is attribution
        only; its capabilities are never trusted — exactly as attributeTo() has
        always treated a till's claim about who is standing there. */
  const operator = await siteQueryOne<
    RowDataPacket & { id: number; name: string; role_id: number | null; is_active: number }
  >(
    siteId,
    'SELECT id, name, role_id, is_active FROM users WHERE id = ?',
    [sale.operatorUserId],
  )

  // A cashier who has since been deleted or deactivated still made a real sale.
  // Post it, attributed to the name the till recorded, and say so.
  const actorName = operator?.is_active
    ? operator.name
    : `${sale.operatorName || 'Unknown'} (offline)`
  if (!operator) {
    reasons.push(`Operator #${sale.operatorUserId} no longer exists`)
  } else if (!operator.is_active) {
    reasons.push(`${operator.name} is no longer active`)
  }
  /*
   * userId 0 for an operator who no longer exists, matching what paidOrders and
   * the contract biller already do for an actor that is not a person in `users`.
   * The NAME is what carries the attribution in that case — "Ruth Mbeki
   * (offline)" — because a foreign key to a deleted row is not available and
   * losing the name would make the sale unattributable entirely.
   */
  const actor = { userId: operator?.id ?? 0, userName: actorName.slice(0, 120) }

  /* 4. A locked VAT period is the one thing that gets quarantined rather than
        posted: writing into a submitted return changes a figure already declared,
        and no exception flag makes that acceptable. */
  if (await isPeriodLocked(siteId, sale.documentDate)) {
    const reason = `The VAT period covering ${sale.documentDate} is locked, so this sale could not be posted.`
    const draft = await saveDraft(siteId, actor, {
      docType: 'invoice',
      documentDate: sale.documentDate,
      ...customerFields(sale),
      terminalId: sale.terminalId ?? null,
      terminalCode: sale.terminalCode ?? null,
      offlineSaleUid: sale.saleUid,
      offlineTakenAt: sqlDateTime(sale.takenAt),
      lines: linesFor(sale),
    })
    await rejectClaim(siteId, sale, draft.ok ? draft.id : null, reason)
    return { saleUid: sale.saleUid, ok: false, error: reason, retryable: false, exception: reason }
  }

  /* 5. Classify against the pricing rules — flagged, never refused (see header).
        Capabilities come from the user's role, never from the payload. */
  const capabilities = await capabilitiesForRole(siteId, operator?.role_id ?? null)
  const priceRefusal = await checkPricing(
    siteId,
    capabilities,
    sale.priceStructureId ?? null,
    sale.lines.map((l) => ({
      productId: l.productId,
      description: l.description,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
    })),
  )
  if (priceRefusal) reasons.push(`Priced beyond what ${actorName} may override: ${priceRefusal}`)

  /* 6. Save the draft. The uid rides in the INSERT so uq_offline_uid protects the
        row from the instant it exists — which is also what makes the next few
        lines necessary. */
  let draft: Awaited<ReturnType<typeof saveDraft>>
  try {
    draft = await saveDraft(siteId, actor, {
      docType: 'invoice',
      documentDate: sale.documentDate,
      ...customerFields(sale),
      terminalId: sale.terminalId ?? null,
      terminalCode: sale.terminalCode ?? null,
      offlineSaleUid: sale.saleUid,
      offlineTakenAt: sqlDateTime(sale.takenAt),
      lines: linesFor(sale),
    })
  } catch (error) {
    /*
     * MEASURED, not hypothesised: four concurrent requests carrying the same uid
     * produce one posted sale and three of these. `uq_offline_uid` is what makes
     * that safe — the shop is paid exactly once — and this branch is only about
     * saying so in words a cashier can act on.
     *
     * Without it the status chip shows
     *   "Duplicate entry '2000…-8000-019fe79e' for key 'uq_offline_uid'"
     * which tells the person at the counter nothing, and reads like data loss when
     * it is in fact the safety net working. Retryable, because the retry then
     * takes the `posted` branch and resolves to the number already issued — also
     * measured.
     */
    if (isDuplicateUid(error)) {
      return {
        saleUid: sale.saleUid,
        ok: false,
        error: 'This sale is already being sent. It will settle on the next attempt.',
        retryable: true,
      }
    }
    throw error
  }
  if (!draft.ok) {
    // saveDraft refuses only on structural grounds, which step 1 already covered
    // — so this is a real bug or a database problem. Retryable: the next attempt
    // may well succeed, and the sale must not be dropped on the floor.
    await failClaim(siteId, sale, draft.error)
    return { saleUid: sale.saleUid, ok: false, error: draft.error, retryable: true }
  }


  /* 7. Compare what the till charged against what the server just computed. The
        server's figure is already the one saved; this only records the gap. */
  const saved = await getDocument(siteId, draft.id)
  if (saved && Math.abs(round(saved.totalIncl - sale.claimedTotalIncl, 2)) >= 0.01) {
    reasons.push(
      `The till charged ${sale.claimedTotalIncl.toFixed(2)} but this basket prices at ` +
        `${saved.totalIncl.toFixed(2)} — the invoice is for ${saved.totalIncl.toFixed(2)}`,
    )
  }

  /* 8. Finalise under the number ALREADY PRINTED, into the shift that took the
        cash. Both are the two optional fields FinaliseInput carries for exactly
        this caller; every online sale still allocates and resolves as before. */
  const posted = await finaliseDocument(siteId, actor, {
    documentId: draft.id,
    tenders: sale.tenders.map((t) => ({
      tenderTypeId: t.tenderTypeId,
      amount: t.amount,
      reference: t.reference ?? null,
    })),
    customerId: sale.customerId ?? null,
    documentNumber: sale.documentNumber,
    shiftId: sale.shiftId ?? null,
  })

  if (!posted.ok) {
    /*
     * The sale is tendered and receipted, so this is not a refusal we can act on
     * — it is a failure to record something that happened. Leave the draft in
     * place (it holds every line and the uid), mark the claim, and let the till
     * retry: a deleted tender type or a since-changed rounding setting are both
     * fixable, after which the same payload posts.
     */
    await failClaim(siteId, sale, posted.error)
    return {
      saleUid: sale.saleUid,
      ok: false,
      documentId: draft.id,
      error: posted.error,
      retryable: true,
    }
  }

  /* 9. Stamp the document, settle the claim, and leave an audit trail. */
  const exception = exceptionText(reasons)
  await settleClaim(siteId, sale, posted.documentId, posted.documentNumber, exception)

  return {
    saleUid: sale.saleUid,
    ok: true,
    documentId: posted.documentId,
    documentNumber: posted.documentNumber,
    exception,
  }
}

/* ── Claim bookkeeping ───────────────────────────────────────────────────── */

/**
 * Marks the sale posted and records how it got here.
 *
 * One transaction, and deliberately AFTER finaliseDocument's own — see the header
 * on the crash window. Everything in here is bookkeeping about a sale that is
 * already safely on the books, which is what makes that window survivable.
 */
async function settleClaim(
  siteId: number,
  sale: OfflineSale,
  documentId: number,
  documentNumber: string,
  exception: string | null,
): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE sales_documents
          SET offline_synced_at = NOW(), offline_exception = ?
        WHERE id = ?`,
      [exception, documentId] as never,
    )
    await tx.execute(
      `UPDATE offline_sync_claims
          SET status = 'posted', document_id = ?, document_number = ?,
              error = NULL, posted_at = NOW()
        WHERE sale_uid = ?`,
      [documentId, documentNumber, sale.saleUid] as never,
    )

    /*
     * document_audit, not activity_log — the same split salesOrders.ts documents:
     * the activity log is about what people did to master data, while a document's
     * own history belongs with the document so the sale's detail screen shows it
     * without joining two trails.
     *
     * In the transaction rather than swallowed after it, because unlike an
     * ordinary audit note this row is the ONLY record that the sale was rung up
     * away from the database. A finalised offline sale with no trail of having
     * been offline is indistinguishable from an ordinary one.
     */
    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, ?, ?, ?, ?)`,
      [
        documentId,
        'offline_synced',
        `Rung up offline at ${sale.takenAt} on till ${sale.terminalCode ?? '?'}`.slice(0, 400),
        sale.operatorUserId ?? null,
        (sale.operatorName ?? '').slice(0, 120),
      ] as never,
    )
    if (exception) {
      await tx.execute(
        `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, ?, ?, ?, ?)`,
        [
          documentId,
          'offline_exception',
          exception,
          sale.operatorUserId ?? null,
          (sale.operatorName ?? '').slice(0, 120),
        ] as never,
      )
    }
  })
}

/** A sale that cannot post at all and needs a human. The till stops retrying. */
async function rejectClaim(
  siteId: number,
  sale: OfflineSale,
  documentId: number | null,
  error: string,
): Promise<void> {
  await siteQueryOne(
    siteId,
    `UPDATE offline_sync_claims
        SET status = 'rejected', document_id = ?, error = ?
      WHERE sale_uid = ?`,
    [documentId, error.slice(0, 400), sale.saleUid],
  ).catch(() => null)
  if (documentId) {
    await siteQueryOne(
      siteId,
      'UPDATE sales_documents SET offline_exception = ? WHERE id = ?',
      [error.slice(0, 400), documentId],
    ).catch(() => null)
  }
}

/**
 * Records a failed attempt WITHOUT rejecting.
 *
 * The claim stays at `claimed`, which is what makes the next attempt try again —
 * the distinction between this and rejectClaim is the whole of the retry policy.
 */
async function failClaim(siteId: number, sale: OfflineSale, error: string): Promise<void> {
  await siteQueryOne(
    siteId,
    'UPDATE offline_sync_claims SET error = ? WHERE sale_uid = ?',
    [error.slice(0, 400), sale.saleUid],
  ).catch(() => null)
}

/* ── Payload → the shapes the posting path already takes ─────────────────── */

function customerFields(sale: OfflineSale) {
  return {
    customerId: sale.customerId ?? null,
    customerName: sale.customerName ?? null,
    customerVatNo: sale.customerVatNo ?? null,
    customerPhone: sale.customerPhone ?? null,
    priceStructureId: sale.priceStructureId ?? null,
  }
}

/**
 * The sale's lines as `LineInput`.
 *
 * Only the inputs are carried across — qty, price, discount, VAT rate — and never
 * a computed total. computeTotals recomputes all of them through documentMath, so
 * a till that got its arithmetic wrong cannot put a wrong figure on an invoice.
 */
function linesFor(sale: OfflineSale): LineInput[] {
  return sale.lines.map((line) => ({
    productId: line.productId ?? null,
    productCode: line.productCode ?? null,
    description: line.description,
    productType: line.productType,
    departmentId: line.departmentId ?? null,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    vatRatePct: line.vatRatePct,
    unitCostExcl: line.unitCostExcl,
    specialId: line.specialId ?? null,
  }))
}

/** An ISO instant as MySQL DATETIME. The till's clock, kept as the till sent it. */
function sqlDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
}

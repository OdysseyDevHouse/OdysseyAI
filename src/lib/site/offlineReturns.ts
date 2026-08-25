import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne, siteTransaction } from '../siteDb'
import { customerExecute } from './customerDb'
import { isLocked } from './periodLocks'
import { can, capabilitiesForRole } from './permissions'
import { createCreditNote } from './salesReversal'
import { adoptDocumentNumber } from './sequences'
import { numberValueOf } from '../numberFormat'
import type { OfflineReturn, SyncReturnResult } from '../posOffline/types'

/**
 * Posting a return that was taken while the till had no database.
 *
 * ── THE SAME RULE AS A SALE, FOR THE SAME REASON ───────────────────────────
 *
 * An offline return is ALWAYS POSTED. By the time this runs the customer has walked
 * out with their money and the goods are back on the shelf. A server that "refuses"
 * it does not un-refund anybody — it just loses the record of cash that has already
 * left the drawer, which is strictly worse than posting it with a flag on it.
 *
 * So the figures are recomputed by `createCreditNote` (the same function the back
 * office uses) and every disagreement becomes an exception on the document rather
 * than a refusal.
 *
 * ── WHAT THIS DOES *NOT* SUPPORT, DELIBERATELY ─────────────────────────────
 *
 * A RECEIPTED return. `creditedQtyByLine` sums every credit note ever raised against
 * an invoice — across every till and the back office — so that nobody can credit more
 * than was sold. A till knows only about its own sales, so it cannot run that guard;
 * two tills, or a return against last week's sale, and it would credit one invoice
 * twice with nothing able to notice.
 *
 * So an offline return posts as `invoiceId: null` — a return WITHOUT a receipt, which
 * reverses nothing in particular and therefore has no over-credit guard to miss. The
 * document says so, and the exception says it was taken blind. That is a genuine
 * limitation, stated rather than papered over.
 *
 * ── THERE IS NO SECOND CREDIT-NOTE PATH ────────────────────────────────────
 *
 * This calls `createCreditNote`. The negative-qty convention, the VAT arithmetic, the
 * cost-from-the-original rule, the stock direction flip, the component explosion for
 * recipes and the customer-ledger posting are all its, unchanged. What this module
 * adds is the claim, the classification and the number adoption.
 */

/* ── Structural validation ───────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Refuses a payload that cannot be a return, or null.
 *
 * Structural only — shape, finiteness, bounds — for the same reason the sale
 * validator is: a business judgement ("that refund looks large") is an exception to
 * record, not a reason to drop money on the floor. Anything refused here is a bug or
 * an attack, and is refused non-retryably so the queue drains.
 */
export function validateOfflineReturn(ret: OfflineReturn): string | null {
  if (!ret || typeof ret !== 'object') return 'Not a return.'
  if (!UUID.test(ret.returnUid ?? '')) return 'Missing or malformed return uid.'
  if (!ret.documentNumber?.trim()) return 'A return taken offline must carry its printed number.'
  if (ret.documentNumber.length > 32) return 'That document number is too long.'
  if (!ISO_DATE.test(ret.documentDate ?? '')) return 'Missing or malformed document date.'
  if (!Number.isFinite(Date.parse(ret.takenAt ?? ''))) return 'Missing or malformed taken-at time.'
  // createCreditNote refuses a missing reason, so refusing it here too means the till
  // hears about it as a structural problem rather than as a mystery rejection.
  // Only the SHAPE is checked here — whether the id names a live return reason is
  // createCreditNote's job, because that answer can change between the sale and the
  // sync and this validator must stay a pure function of the payload.
  if (!Number.isInteger(ret.reasonId) || ret.reasonId <= 0) {
    return 'A return must carry a reason.'
  }

  if (!Array.isArray(ret.lines) || ret.lines.length === 0) return 'A return must have lines.'
  if (ret.lines.length > 500) return 'A return cannot have more than 500 lines.'
  for (const [i, line] of ret.lines.entries()) {
    const where = `Line ${i + 1}`
    if (!line.description?.trim()) return `${where}: no description.`
    // POSITIVE, because the till sends "credit 2" and createCreditNote stores −2.
    // A negative here would double-negate into a second sale.
    if (!Number.isFinite(line.qty) || line.qty <= 0) return `${where}: bad quantity.`
    if (!Number.isFinite(line.unitPriceIncl) || line.unitPriceIncl < 0) return `${where}: bad price.`
    if (!Number.isFinite(line.vatRatePct) || line.vatRatePct < 0 || line.vatRatePct > 100) {
      return `${where}: bad VAT rate.`
    }
    if (!Number.isFinite(line.unitCostExcl) || line.unitCostExcl < 0) return `${where}: bad cost.`
  }

  // Refunds MAY be empty — that is a credit left sitting on the account, which is a
  // legitimate outcome rather than a missing field.
  if (!Array.isArray(ret.refunds)) return 'Bad refunds.'
  if (ret.refunds.length > 20) return 'Too many refunds on one return.'
  for (const refund of ret.refunds) {
    if (!Number.isInteger(refund.tenderTypeId) || refund.tenderTypeId <= 0) {
      return 'Bad refund method.'
    }
    if (!Number.isFinite(refund.amount) || refund.amount < 0) return 'Bad refund amount.'
  }

  for (const claimed of [ret.claimedTotalIncl, ret.claimedRefundTotal]) {
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
  attempts: number
}

/**
 * Takes the uid, or reports that somebody already has it.
 *
 * One INSERT … ON DUPLICATE, same as the sales claim: a till WILL send the same
 * batch twice, because "the request timed out" and "the request succeeded and the
 * response was lost" look identical from a shop counter. For a REFUND the stakes are
 * the mirror of a sale's — a double-posted return pays the customer twice.
 */
async function claim(
  siteId: number,
  ret: OfflineReturn,
): Promise<{ fresh: boolean; row: ClaimRow }> {
  const result = await siteExecute(
    siteId,
    `INSERT INTO offline_return_claims (return_uid, terminal_id, operator_name, attempts)
     VALUES (?,?,?,1)
     ON DUPLICATE KEY UPDATE attempts = attempts + 1`,
    [ret.returnUid, ret.terminalId ?? null, (ret.operatorName ?? '').slice(0, 120)],
  )

  /*
   * WHICH REQUEST WON, and this is load-bearing rather than informational.
   *
   * MySQL reports affectedRows = 1 for a fresh INSERT and 2 when ON DUPLICATE KEY
   * updated an existing row, so it distinguishes the winner from every loser without
   * a second read — and without a read-then-write race, which is the whole reason the
   * claim is an upsert.
   *
   * MEASURED BUG this fixes: without it, four concurrent requests carrying one return
   * produced THREE credit notes. All four saw status='claimed' with no document_id yet
   * (the winner had not finished), all four decided to proceed, and all four called
   * createCreditNote. The sales path is immune because saveDraft carries the uid IN
   * ITS INSERT, so uq_offline_uid refuses the losers at the database — but a credit
   * note is stamped with its uid AFTER createCreditNote returns, far too late to
   * collide. Two of the three had offline_sale_uid NULL and no exception, so they were
   * indistinguishable from ordinary back-office credit notes: a customer refunded R46
   * with R138 of credit notes on the books, and nothing flagged.
   */
  const affected = (result as { affectedRows?: number })?.affectedRows ?? 0

  const row = await siteQueryOne<ClaimRow>(
    siteId,
    `SELECT status, document_id, document_number, error, attempts
       FROM offline_return_claims WHERE return_uid = ?`,
    [ret.returnUid],
  )
  if (!row) throw new Error('The return claim could not be read back.')
  return { fresh: affected === 1, row }
}

async function settleClaim(
  siteId: number,
  ret: OfflineReturn,
  documentId: number,
  documentNumber: string,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE offline_return_claims
        SET status = 'posted', document_id = ?, document_number = ?, posted_at = NOW(), error = NULL
      WHERE return_uid = ?`,
    [documentId, documentNumber, ret.returnUid],
  )
}

async function rejectClaim(
  siteId: number,
  ret: OfflineReturn,
  documentId: number | null,
  error: string,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE offline_return_claims
        SET status = 'rejected', document_id = ?, error = ?
      WHERE return_uid = ?`,
    [documentId, error.slice(0, 400), ret.returnUid],
  )
}

async function failClaim(siteId: number, ret: OfflineReturn, error: string): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE offline_return_claims SET error = ? WHERE return_uid = ?`,
    [error.slice(0, 400), ret.returnUid],
  ).catch(() => null)
}

function exceptionText(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null
  return reasons.join(' · ').slice(0, 400)
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

/**
 * Posts one offline return, idempotently.
 *
 * Returns a per-return result rather than throwing, so one bad return cannot lose the
 * good ones beside it in the batch.
 */
export async function postOfflineReturn(
  siteId: number,
  ret: OfflineReturn,
): Promise<SyncReturnResult> {
  /* 1. Structure. A malformed payload is a bug, not a return. */
  const malformed = validateOfflineReturn(ret)
  if (malformed) {
    return { returnUid: ret?.returnUid ?? '', ok: false, error: malformed, retryable: false }
  }

  const reasons: string[] = []

  /* 2. Claim the uid, and answer from the claim when it is already resolved. */
  const { fresh, row: existing } = await claim(siteId, ret)

  if (existing.status === 'posted' && existing.document_number) {
    return {
      returnUid: ret.returnUid,
      ok: true,
      duplicate: true,
      documentId: existing.document_id ?? undefined,
      documentNumber: existing.document_number,
    }
  }
  if (existing.status === 'rejected') {
    return {
      returnUid: ret.returnUid,
      ok: false,
      error: existing.error ?? 'This return was refused and needs a manager.',
      retryable: false,
    }
  }
  /*
   * `claimed` WITH a document — the crash window between the credit note committing
   * and the claim being updated. The document is on the books, so completing the
   * claim is the correct repair; re-posting would refund the customer twice.
   *
   * This is the same weakness postOfflineSale documents and accepts: getting the
   * credit note and the claim into one transaction would mean createCreditNote taking
   * an outer connection, which is a refactor of a money-moving function to serve a
   * recovery path that this branch already handles.
   */
  if (existing.status === 'claimed' && existing.document_id) {
    const doc = await siteQueryOne<RowDataPacket & { document_number: string; status: string }>(
      siteId,
      'SELECT document_number, status FROM sales_documents WHERE id = ?',
      [existing.document_id],
    )
    if (doc && doc.status === 'finalised') {
      await settleClaim(siteId, ret, existing.document_id, doc.document_number)
      return {
        returnUid: ret.returnUid,
        ok: true,
        duplicate: true,
        documentId: existing.document_id,
        documentNumber: doc.document_number,
      }
    }
  }

  /*
   * 2b. ONLY THE REQUEST THAT WON THE CLAIM MAY POST.
   *
   * Everything above resolves a claim that has already FINISHED. This handles the one
   * still in flight: a second request arriving while the winner is mid-createCreditNote
   * sees status='claimed' with no document_id, which is indistinguishable from a crash
   * — except that it is not, and posting would refund the customer twice.
   *
   * So a loser is told to come back. Retryable, deliberately: by its next attempt the
   * winner has either settled the claim (and the retry takes the `posted` branch and
   * resolves to the number already issued) or genuinely crashed (and the retry finds
   * document_id set, or an unresolved claim it may then take).
   *
   * ── AND THE CRASH CASE, WHICH THIS MUST NOT STRAND ───────────────────────
   *
   * `fresh` is false for every attempt after the first, so on its own this rule would
   * strand a return whose winner died BEFORE creating the document: no document_id to
   * recover from, and no attempt ever fresh again. The refund would sit in the queue
   * forever and never reach the books — which is the failure this whole module exists
   * to prevent, arrived at from the other direction.
   *
   * So a claim that is unresolved AND has gone quiet may be taken over. The window is
   * generous on purpose: createCreditNote posts stock movements and a ledger entry, so
   * a slow one is measured in seconds, and re-posting a refund is far worse than
   * waiting another minute to retry.
   */
  const STALE_CLAIM_SECONDS = 120
  if (!fresh) {
    const stale = await siteQueryOne<RowDataPacket & { stale: number }>(
      siteId,
      `SELECT TIMESTAMPDIFF(SECOND, claimed_at, NOW()) >= ? AS stale
         FROM offline_return_claims WHERE return_uid = ?`,
      [STALE_CLAIM_SECONDS, ret.returnUid],
    )
    if (!stale?.stale) {
      return {
        returnUid: ret.returnUid,
        ok: false,
        error: 'This return is already being sent. It will settle on the next attempt.',
        retryable: true,
      }
    }
    /* Taken over. `claimed_at` is reset so two retries arriving together cannot BOTH
       decide the claim is stale and post — the first to update it wins, and the second
       reads a fresh timestamp. */
    const took = await siteExecute(
      siteId,
      `UPDATE offline_return_claims
          SET claimed_at = NOW()
        WHERE return_uid = ?
          AND status = 'claimed'
          AND document_id IS NULL
          AND TIMESTAMPDIFF(SECOND, claimed_at, NOW()) >= ?`,
      [ret.returnUid, STALE_CLAIM_SECONDS],
    )
    if (((took as { affectedRows?: number })?.affectedRows ?? 0) === 0) {
      return {
        returnUid: ret.returnUid,
        ok: false,
        error: 'This return is already being sent. It will settle on the next attempt.',
        retryable: true,
      }
    }
    reasons.push('Recovered after an interrupted first attempt')
  }

  /* 3. Resolve the operator SERVER-SIDE. The payload's name is attribution only. */
  const operator = await siteQueryOne<RowDataPacket & { id: number; name: string; role_id: number | null; is_active: number }>(
    siteId,
    'SELECT id, name, role_id, is_active FROM users WHERE id = ?',
    [ret.operatorUserId],
  )
  if (!operator) {
    reasons.push(`Operator #${ret.operatorUserId} no longer exists`)
  } else if (!operator.is_active) {
    reasons.push(`${operator.name} is no longer an active user`)
  }

  const actorName = operator?.name ?? `${ret.operatorName || 'Offline cashier'} (offline)`
  const actor = { userId: operator?.id ?? 0, userName: actorName.slice(0, 120) }

  /*
   * 4. Did whoever authorised this actually hold the capability?
   *
   * Re-derived from the role, NEVER read from the payload — the till's answer was
   * only as fresh as its last catalog, and somebody whose permission was withdrawn
   * yesterday could still have been offered the button. Flagged rather than refused:
   * the money is already gone, so the useful outcome is a manager knowing about it.
   */
  const authoriserId = ret.authorisedByUserId ?? ret.operatorUserId
  const authoriser =
    authoriserId === ret.operatorUserId
      ? operator
      : await siteQueryOne<RowDataPacket & { id: number; name: string; role_id: number | null }>(
          siteId,
          'SELECT id, name, role_id FROM users WHERE id = ?',
          [authoriserId],
        )
  const authCaps = await capabilitiesForRole(siteId, authoriser?.role_id ?? null)
  if (!can(authCaps, 'sales.credit_note')) {
    const who = authoriser?.name ?? ret.authorisedByName ?? actorName
    reasons.push(`${who} does not hold permission to raise a credit note`)
  }

  /* 5. It was taken blind — always true offline, and always worth saying.
        A manager reading the exceptions screen needs to know this credit note was
        raised with no invoice checked against it, because that is the one control
        an offline return cannot run. */
  reasons.push('Taken offline with no receipt checked')

  /* 6. A locked VAT period quarantines rather than posts — the same carve-out a sale
        gets, and for the same reason: writing into a submitted return restates a
        figure already declared.

        There is no draft to fall back on here, because a credit note has no draft
        state in this codebase — createCreditNote finalises in one step. So the claim
        carries the whole record, and the exceptions screen shows it as refused with
        the reason. The cash is still out of the drawer; what a manager gets is the
        evidence, and a decision to make. */
  const lockCheck = await isLocked(siteId, ret.documentDate, 'sales')
  if (lockCheck.refused) {
    const reason =
      lockCheck.message ??
      `The VAT period covering ${ret.documentDate} is locked, so this return could not be posted.`
    await rejectClaim(siteId, ret, null, reason)
    return {
      returnUid: ret.returnUid,
      ok: false,
      error: reason,
      retryable: false,
      exception: reason,
    }
  }
  if (lockCheck.locked) {
    // A soft lock cautions rather than files — the money already left the
    // drawer, so the return posts and the disagreement rides as an exception.
    reasons.push(`Posted into a period being finalised: ${lockCheck.message ?? ret.documentDate}`)
  }

  /* 7. Post it, through the one credit-note path there is. */
  const created = await createCreditNote(siteId, actor, {
    // NULL, always. See the header: a till cannot run the over-credit guard.
    invoiceId: null,
    customerId: ret.customerId ?? null,
    customerName: ret.customerName ?? null,
    reasonId: ret.reasonId,
    note: ret.note,
    terminalId: ret.terminalId ?? null,
    terminalCode: ret.terminalCode ?? null,
    lines: ret.lines.map((l) => ({
      sourceLineId: null,
      productId: l.productId,
      productCode: l.productCode,
      description: l.description,
      productType: l.productType,
      departmentId: l.departmentId,
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      vatRatePct: l.vatRatePct,
      // The till's catalog cost, carried rather than re-read — re-reading would
      // value the return at today's cost and manufacture margin never earned.
      unitCostExcl: l.unitCostExcl,
      // The lot off the pack (236). Absent on a return queued before this
      // shipped, and on every shop that does not capture lots — both of which
      // fall back to the newest lot exactly as they did.
      batchNo: l.batchNo,
    })),
    refunds: ret.refunds.map((r) => ({
      tenderTypeId: r.tenderTypeId,
      amount: r.amount,
      reference: r.reference,
    })),
  })

  if (!created.ok) {
    /*
     * createCreditNote refused. Its refusals are business ones — a tender that no
     * longer allows refunds, a refund larger than the credit — and offline the till
     * could not have known. Retryable is FALSE: the same payload will be refused
     * identically forever, so a human has to look.
     */
    await rejectClaim(siteId, ret, null, created.error)
    return {
      returnUid: ret.returnUid,
      ok: false,
      error: created.error,
      retryable: false,
      exception: created.error,
    }
  }

  /* 8. Compare what the till told the customer against what the server computed.
        The server's figure is what stands; a difference is an exception, because a
        customer was handed a slip with the till's number on it. */
  const serverTotal = Math.abs(created.total)
  if (Math.abs(serverTotal - Math.abs(ret.claimedTotalIncl)) > 0.005) {
    reasons.push(
      `The till credited ${Math.abs(ret.claimedTotalIncl).toFixed(2)} but the server computed ${serverTotal.toFixed(2)}`,
    )
  }

  /*
   * 9. Adopt the number the customer is holding, and stamp the offline columns.
   *
   * The credit note was created under a number createCreditNote allocated from the
   * SITE-WIDE sequence, which is not the number printed on the slip in the
   * customer's hand. So the document is renumbered to the printed one and the till's
   * own sequence advanced past it.
   *
   * Deliberately AFTER the credit note commits rather than by threading a
   * documentNumber parameter through createCreditNote: that function is the back
   * office's credit-note path as well, and adding an "actually use this number"
   * argument to it puts an offline concern inside the function every manual credit
   * note in the product goes through. The renumber is one UPDATE guarded by
   * uq_doc_number, which is what refuses a genuine collision.
   */
  const printed = ret.documentNumber.trim()
  let renumbered = printed
  try {
    await siteTransaction(siteId, async (tx) => {
      await tx.execute(
        `UPDATE sales_documents
            SET document_number  = ?,
                offline_sale_uid = ?,
                offline_taken_at = ?,
                offline_synced_at = NOW(),
                offline_exception = ?
          WHERE id = ?`,
        [
          printed,
          ret.returnUid,
          sqlDateTime(ret.takenAt),
          exceptionText(reasons),
          created.documentId,
        ] as never,
      )
      const value = numberValueOf(printed)
      if (value !== null && ret.terminalId) {
        await adoptDocumentNumber(tx, 'credit_sale', ret.terminalId, value)
      }
    })

    /*
     * The CUSTOMER LEDGER carries the number too, and it must move with the
     * document.
     *
     * `postTransaction` stores `doc_number` as a literal string when a credit is
     * left on an account, and `customer_transactions` even guards against two rows
     * sharing one number. Renumbering only `sales_documents` would leave a
     * statement citing CRN003817 for a credit note that now calls itself
     * CRN_01_09_000001 — while the customer holds a slip bearing the second. The
     * row is found by source_doc_id, which the renumber does not touch.
     *
     * ── OUTSIDE THE TRANSACTION ABOVE, AND SCOPED BY ORIGIN ────────────────
     *
     * Two reasons, both from the shared customer file:
     *
     *   · The ledger may live in ANOTHER database — the group's primary — and no
     *     transaction spans two. It runs after the document renumber commits,
     *     which is the same ordering postTransaction already uses for exactly
     *     this reason: a ledger failure must not un-do a document.
     *   · source_doc_id names a document in THIS store, and document ids are
     *     per-database. Without the origin scope this UPDATE could rewrite the
     *     credit-note number on another branch's ledger row.
     */
    await customerExecute(
      siteId,
      `UPDATE customer_transactions
          SET doc_number = ?
        WHERE source = 'sale' AND source_doc_id = ? AND doc_type = 'credit_note'
          AND (origin_site_id IS NULL OR origin_site_id = ?)`,
      [printed, created.documentId, siteId],
    )
  } catch (error) {
    /*
     * The credit note IS posted — the customer has their money and the stock is back.
     * Only the renumber failed, which almost certainly means uq_doc_number refused
     * the printed number because something else already has it.
     *
     * So this is reported as posted-with-an-exception under the number it actually
     * carries, rather than as a failure: telling the till to retry would re-post the
     * refund, and telling it the return failed would be false.
     */
    const message = error instanceof Error ? error.message : String(error)
    renumbered = created.documentNumber
    reasons.push(`Could not adopt the printed number ${printed}: ${message}`)
    await siteExecute(
      siteId,
      `UPDATE sales_documents
          SET offline_sale_uid = ?, offline_taken_at = ?, offline_synced_at = NOW(),
              offline_exception = ?
        WHERE id = ?`,
      [ret.returnUid, sqlDateTime(ret.takenAt), exceptionText(reasons), created.documentId],
    ).catch(() => null)
    await failClaim(siteId, ret, message)
  }

  await settleClaim(siteId, ret, created.documentId, renumbered)

  return {
    returnUid: ret.returnUid,
    ok: true,
    documentId: created.documentId,
    documentNumber: renumbered,
    exception: exceptionText(reasons),
  }
}

/** ISO 8601 from the till to the DATETIME the column wants. */
function sqlDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ')
}

import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { postOfflineSale, recordCancelledSale } from '@/lib/site/offlineSync'
import { postOfflineReturn } from '@/lib/site/offlineReturns'
import { postOfflineMovement, postOfflineShift } from '@/lib/site/offlineShifts'
import type {
  CancelledSale,
  OfflineMovement,
  OfflineReturn,
  OfflineSale,
  OfflineShift,
  SyncMovementResult,
  SyncResponse,
  SyncReturnResult,
  SyncSaleResult,
  SyncShiftResult,
} from '@/lib/posOffline/types'

export const dynamic = 'force-dynamic'

/**
 * Where an offline till's queue comes home.
 *
 * ── ONE ORDERED PAYLOAD, NOT SIX ENDPOINTS ────────────────────────────────
 *
 * The reference POS flushed shifts, sales, voids and drawer movements through
 * separate endpoints and left the ORDER to the client's flush sequence. But the
 * order is a correctness requirement — a sale must not post before the shift it
 * banks into exists — so it belongs on the server, where it cannot be got wrong by
 * a client that retried half a batch.
 *
 * Today it carries shifts, then sales, then returns, then drawer movements, then
 * cancellations, in that fixed order — see the comment above each loop for why each
 * sits where it does.
 *
 * ── SHIFTS GO FIRST, AND THAT IS THE ORDER'S WHOLE POINT ──────────────────
 *
 * A till that rebooted during an outage opens its next shift OFFLINE (252), and
 * every sale rung up afterwards names that shift by UID because it had no id yet.
 * So the shift must exist before the sales that bank into it, and the movements
 * that hang off it must come after both.
 *
 * That dependency is exactly the argument this route's own header has always made
 * about cancellations: an order that a client's flush sequence could get wrong is
 * an order that belongs on the server. `shiftIds` below is the map the rest of the
 * batch resolves through, and it is built HERE — the one place that has just
 * written those rows — rather than re-read by each consumer.
 *
 * ── SALES POST OLDEST FIRST, SEQUENTIALLY ─────────────────────────────────
 *
 * Not `Promise.all`. Two reasons, and both are real:
 *
 *   · Numbering. Sales from one till arrive in the order they were rung up, and
 *     `adoptDocumentNumber` advances that till's sequence with GREATEST — order
 *     does not corrupt it, but a gapless register is easier to read when the rows
 *     go in in order.
 *   · Stock and ledger contention. Twenty-five concurrent finalises against the
 *     same products take the same row locks and would spend their time waiting on
 *     each other, which is slower than doing them one at a time as well as harder
 *     to reason about when one fails.
 *
 * ── A REJECTED SALE DOES NOT STOP THE BATCH ───────────────────────────────
 *
 * Every sale gets its own result. One malformed payload must not cost the other
 * twenty-four their revenue, and a till that has to send its whole queue again
 * because sale 3 was bad is a till whose queue never drains.
 */

/** What one request may carry. 25 on the client; this is the hard ceiling. */
const MAX_SALES = 50

export async function POST(request: NextRequest) {
  /*
   * The same capability the till screen itself needs. NOT a separate "sync"
   * capability: whoever may ring up a sale may deliver the ones already rung up,
   * and a second capability would only create a state where a shop can trade
   * offline and then never get the money onto the books.
   */
  const siteId = await siteIdForCapability('sales.till')
  if (!siteId) {
    // JSON, never a redirect. A sync loop that receives the login page's HTML
    // dies inside JSON.parse and tells the cashier nothing — see proxy.ts, which
    // answers /api/* with 401 for this reason.
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  let body: {
    shifts?: unknown
    sales?: unknown
    returns?: unknown
    movements?: unknown
    cancellations?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  const sales = body?.sales
  if (!Array.isArray(sales)) {
    return NextResponse.json({ error: 'Expected a sales array.' }, { status: 400 })
  }
  if (sales.length > MAX_SALES) {
    return NextResponse.json(
      { error: `Send at most ${MAX_SALES} sales at a time.` },
      { status: 400 },
    )
  }

  const shifts = Array.isArray(body?.shifts) ? body.shifts : []
  if (shifts.length > MAX_SALES) {
    return NextResponse.json(
      { error: `Send at most ${MAX_SALES} shifts at a time.` },
      { status: 400 },
    )
  }

  const movements = Array.isArray(body?.movements) ? body.movements : []
  if (movements.length > MAX_SALES) {
    return NextResponse.json(
      { error: `Send at most ${MAX_SALES} drawer movements at a time.` },
      { status: 400 },
    )
  }

  const returns = Array.isArray(body?.returns) ? body.returns : []
  if (returns.length > MAX_SALES) {
    return NextResponse.json(
      { error: `Send at most ${MAX_SALES} returns at a time.` },
      { status: 400 },
    )
  }

  const cancellations = Array.isArray(body?.cancellations) ? body.cancellations : []
  if (cancellations.length > MAX_SALES) {
    return NextResponse.json(
      { error: `Send at most ${MAX_SALES} cancellations at a time.` },
      { status: 400 },
    )
  }

  /*
   * Shifts FIRST, and their answers kept.
   *
   * A shift that fails does NOT stop the batch, for the same reason a rejected
   * sale does not: one malformed payload must not cost the other twenty-four
   * their revenue. What a failed shift costs is narrower and worth being precise
   * about — the sales naming its uid fall through to a null shift, which is a
   * legitimate state `finaliseDocument` has always accepted. The money reaches
   * the books; it reaches no reconciliation. On the books unreconciled beats not
   * on the books.
   */
  const shiftResults: SyncShiftResult[] = []
  /* uid → the real id, for the sales and movements behind it. Also carries the
     ADOPTED ones, which is the point: those sales bank into the drawer that was
     already open, which is where their cash physically is. */
  const shiftIds = new Map<string, number>()
  for (const entry of shifts as OfflineShift[]) {
    try {
      const result = await postOfflineShift(siteId, entry)
      if (result.ok && result.shiftId) shiftIds.set(result.shiftUid, result.shiftId)
      shiftResults.push(result)
    } catch (error) {
      /* RETRYABLE, matching a sale's unexpected throw: opening a shift is one
         insert, so a failure here is a dropped connection or a deadlock rather
         than anything about the payload. The uid makes the retry a no-op. */
      shiftResults.push({
        shiftUid: (entry as OfflineShift)?.shiftUid ?? '',
        ok: false,
        error: error instanceof Error ? error.message : 'The shift could not be opened.',
        retryable: true,
      })
    }
  }

  const resolveShiftUid = (uid: string) => shiftIds.get(uid)

  const results: SyncSaleResult[] = []
  for (const sale of sales as OfflineSale[]) {
    try {
      results.push(await postOfflineSale(siteId, sale, resolveShiftUid))
    } catch (error) {
      /*
       * An unexpected throw — a dropped connection, a deadlock — is RETRYABLE.
       * The sale happened; the failure is ours. Marking it non-retryable here
       * would discard real revenue because the database blinked, and the claim
       * row is what makes the retry safe.
       */
      results.push({
        saleUid: (sale as OfflineSale)?.saleUid ?? '',
        ok: false,
        error: error instanceof Error ? error.message : 'The sale could not be posted.',
        retryable: true,
      })
    }
  }

  /*
   * Cancellations LAST, after every sale in this batch.
   *
   * The order is a correctness requirement, not tidiness. A cancelled sale and a
   * posted one are mutually exclusive outcomes for the same uid, and the till may
   * have both in flight — a sale queued, then cancelled before the flush finished.
   * Recording the cancellation first and then posting the sale would leave the shop
   * with an invoice AND an audit row saying it never happened.
   *
   * Sales first is also the safer order to be wrong in: `postOfflineSale` is
   * idempotent through its claim, so a cancellation arriving for an already-posted
   * uid is recorded as the audit fact it is, and the sale stays on the books where
   * the customer's slip says it should be.
   */
  /*
   * Returns AFTER sales, BEFORE cancellations.
   *
   * A return and a sale are independent documents, so neither one's arithmetic depends
   * on the other. What does depend on the order is how `stock_movements` READS: a sale
   * that drove a product negative and a return that put it back make sense in the
   * order they happened, and a buyer working out why a count is wrong should not have
   * to reason about sync order to follow it.
   *
   * Before cancellations for the same reason sales are: a cancellation is the last
   * word on a uid, and it must not be overtaken by the thing it cancels.
   */
  const returnResults: SyncReturnResult[] = []
  for (const entry of returns as OfflineReturn[]) {
    try {
      returnResults.push(await postOfflineReturn(siteId, entry))
    } catch (error) {
      /* Retryable, exactly as for a sale: the refund already happened, so an
         unexpected throw is our failure and not a reason to discard the record of
         cash that has left the drawer. The claim row is what makes the retry safe. */
      returnResults.push({
        returnUid: (entry as OfflineReturn)?.returnUid ?? '',
        ok: false,
        error: error instanceof Error ? error.message : 'The return could not be posted.',
        retryable: true,
      })
    }
  }

  /*
   * Drawer movements, after the shifts they belong to and after the sales.
   *
   * After the shifts is a requirement: a movement is ON DELETE CASCADE from a row
   * that has to be there, and one naming a uid resolves through the map built
   * above. After the sales is a choice — a payout and a sale touch different
   * tables and neither figure depends on the other — made because
   * `listDrawerMovements` and the sale register are both read by somebody working
   * out why a drawer is short, and both reading in the order the shop traded is
   * worth more than it costs.
   */
  const movementResults: SyncMovementResult[] = []
  for (const entry of movements as OfflineMovement[]) {
    try {
      movementResults.push(await postOfflineMovement(siteId, entry, resolveShiftUid))
    } catch (error) {
      /* Retryable, as a sale's throw is: the money left the drawer, and the
         failure is ours. The uid is what makes trying again safe — without it a
         second attempt would take the same R50 out twice. */
      movementResults.push({
        movementUid: (entry as OfflineMovement)?.movementUid ?? '',
        ok: false,
        error: error instanceof Error ? error.message : 'The movement could not be recorded.',
        retryable: true,
      })
    }
  }

  const cancelled: { saleUid: string; ok: boolean; error?: string }[] = []
  for (const entry of cancellations as CancelledSale[]) {
    try {
      const result = await recordCancelledSale(siteId, entry)
      cancelled.push({ saleUid: entry?.saleUid ?? '', ok: result.ok, error: result.error })
    } catch (error) {
      cancelled.push({
        saleUid: entry?.saleUid ?? '',
        ok: false,
        error: error instanceof Error ? error.message : 'The cancellation could not be recorded.',
      })
    }
  }

  return NextResponse.json({
    shifts: shiftResults,
    results,
    returns: returnResults,
    movements: movementResults,
    cancelled,
  } satisfies SyncResponse)
}

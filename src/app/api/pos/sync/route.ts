import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { postOfflineSale, recordCancelledSale } from '@/lib/site/offlineSync'
import { postOfflineReturn } from '@/lib/site/offlineReturns'
import type {
  CancelledSale,
  OfflineReturn,
  OfflineSale,
  SyncResponse,
  SyncReturnResult,
  SyncSaleResult,
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
 * Today it carries sales, then returns, then cancellations, in that fixed order — see
 * the comment above each loop for why each sits where it does. Shifts and drawer
 * movements join it as further fields on the same request rather than as further routes.
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

  let body: { sales?: unknown; returns?: unknown; cancellations?: unknown }
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

  const results: SyncSaleResult[] = []
  for (const sale of sales as OfflineSale[]) {
    try {
      results.push(await postOfflineSale(siteId, sale))
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
    results,
    returns: returnResults,
    cancelled,
  } satisfies SyncResponse)
}

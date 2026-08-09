import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { postOfflineSale } from '@/lib/site/offlineSync'
import type { OfflineSale, SyncResponse, SyncSaleResult } from '@/lib/posOffline/types'

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
 * Today that array is sales only. Shifts, voids and drawer movements join it as
 * further fields on the same request, processed in a fixed order, rather than as
 * further routes.
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

  let body: { sales?: unknown }
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

  return NextResponse.json({ results } satisfies SyncResponse)
}

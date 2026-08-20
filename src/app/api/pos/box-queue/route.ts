import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { queueSale, outboxCounts } from '@/lib/site/boxOutbox'
import { tabsAreLocal } from '@/lib/site/tabRouting'
import { validateOfflineSale } from '@/lib/site/offlineSync'
import type { OfflineSale } from '@/lib/posOffline/types'

export const dynamic = 'force-dynamic'

/**
 * Where a hybrid till's finalised sale lands.
 *
 * ── WHY THE QUEUE MOVES OFF THE DEVICE ────────────────────────────────────
 *
 * On an ordinary site a till holds its own outbox in IndexedDB and flushes it
 * to /api/pos/sync. That is right when the device is the only thing that knows
 * about the sale.
 *
 * On a HYBRID site it is not. The tab lives on the shop's box, so when a waiter
 * closes it the box is what has the sale — and ten devices each holding part of
 * one shop's takings is a shop whose money walks out in somebody's bag. The
 * device posts the finalised sale here; the box owns the queue from then on.
 *
 * ── THIS DOES NOT POST ────────────────────────────────────────────────────
 *
 * It queues. The box never calls finaliseDocument — posting reaches stock, the
 * ledger, loyalty, serials, tips and shifts, none of which the box has, and two
 * stock ledgers cannot be reconciled. The cloud posts, through the same path an
 * offline till's sale takes (lib/site/offlineSync.ts: "there is no second
 * posting path").
 *
 * So a 200 here means "recorded, and it will reach the books" — NOT "on the
 * books". That distinction is the same one the device outbox already makes, and
 * the till's pending count means the same thing on both.
 *
 * ── AN API ROUTE, NOT A SERVER ACTION ─────────────────────────────────────
 *
 * Same reasoning as /api/pos/catalog: the till drives this from code that owns
 * its own retry, and `siteIdForCapability` exists because API routes sit outside
 * `(app)` and cannot lean on its layout gate.
 */

/** One sale per request. A tab is closed one at a time by one waiter. */
export async function POST(request: NextRequest) {
  /*
   * The same capability the till screen needs. NOT a separate one: whoever may
   * ring up a sale may record the one they just rang up, and a second capability
   * would create a state where a shop can trade and then not bank it.
   */
  const siteId = await siteIdForCapability('sales.till')
  if (!siteId) {
    /* JSON, never a redirect. A till loop that receives the login page's HTML
       dies inside JSON.parse and tells the cashier nothing — see proxy.ts. */
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  /*
   * Refused on a site with no box, rather than silently falling back.
   *
   * A till that reached here on a cloud site has been misconfigured, and
   * accepting the sale into a queue nothing flushes would lose it quietly. The
   * device's own outbox is the right home there, and it already works.
   */
  if (!(await tabsAreLocal(siteId))) {
    return NextResponse.json(
      { error: 'This site does not keep its sales on an in-store box.' },
      { status: 409 },
    )
  }

  let sale: OfflineSale
  try {
    sale = (await request.json()) as OfflineSale
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }

  /*
   * The SAME structural validation the cloud applies on arrival.
   *
   * Deliberately structural only — shape, finiteness, bounds. It must never
   * refuse on a business judgement: a price that looks wrong is an exception for
   * a manager to see, recorded against the posted document, not a reason to
   * reject money that has already changed hands.
   *
   * Checking here as well as at /api/pos/sync is not redundant. A payload that
   * cannot be posted should be refused while the cashier is still standing
   * there, rather than sitting in the box's queue until the line comes back and
   * failing in front of nobody.
   */
  const invalid = validateOfflineSale(sale)
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 })
  }

  try {
    const { queued } = await queueSale(siteId, sale)
    const counts = await outboxCounts(siteId)

    /*
     * `queued: false` is SUCCESS, not a failure.
     *
     * It means this uid is already in the queue — a till that retried after a
     * timeout, which is the ordinary shape of a flaky LAN. The unique index made
     * the retry a no-op, and telling the till "already recorded" is what stops
     * it queueing the same takings twice.
     */
    return NextResponse.json({
      ok: true,
      duplicate: !queued,
      saleUid: sale.saleUid,
      documentNumber: sale.documentNumber,
      pending: counts.pending,
    })
  } catch (error) {
    /*
     * The box is unreachable or refused the write. NOTHING was recorded, so the
     * till must keep the sale: it falls back to its own outbox, which is exactly
     * what that outbox is for. Saying so plainly matters — a 500 the till reads
     * as "maybe recorded" would leave it guessing whether to keep the row.
     */
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'The sale could not be recorded.',
        recorded: false,
      },
      { status: 503 },
    )
  }
}

/** What the till's header chip reads: how much money is not yet on the books. */
export async function GET() {
  const siteId = await siteIdForCapability('sales.till')
  if (!siteId) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  if (!(await tabsAreLocal(siteId))) return NextResponse.json({ boxed: false })

  try {
    const counts = await outboxCounts(siteId)
    return NextResponse.json({ boxed: true, ...counts })
  } catch {
    /* The box is down. The till has its own fallback and its own count; saying
       "unknown" beats a number that is wrong. */
    return NextResponse.json({ boxed: true, reachable: false })
  }
}

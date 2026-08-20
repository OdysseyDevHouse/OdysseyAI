import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { flushOnce, prune, outboxCounts, BoxTransportError } from '@/lib/site/boxOutbox'
import { tabsAreLocal } from '@/lib/site/tabRouting'
import { postOfflineSale } from '@/lib/site/offlineSync'
import type { OfflineSale, SyncSaleResult } from '@/lib/posOffline/types'

export const dynamic = 'force-dynamic'
/** A shop's whole service can be waiting. Posting is sequential by design. */
export const maxDuration = 300

/**
 * The box's heartbeat — call it from cron on the machine in the shop.
 *
 * Every run: flush what is pending to the cloud, then prune what the cloud has
 * had for a week. Both are safe to call often and safe to miss.
 *
 * ── SAFE TO CALL OFTEN ────────────────────────────────────────────────────
 *
 * `sale_uid` is the idempotency key and the cloud claims against it, so a sale
 * delivered twice posts once — the second answer comes back `duplicate: true`,
 * which this treats as success. Two overlapping runs cost a wasted request, not
 * a doubled invoice.
 *
 * ── AND SAFE TO MISS ──────────────────────────────────────────────────────
 *
 * Nothing expires. A box that could not reach the cloud for a week flushes the
 * whole week on the next run, oldest first, and every sale keeps the number
 * already printed on the customer's slip. That is the entire point: the shop
 * trades through the outage and the books catch up afterwards.
 *
 * Once a minute is a reasonable cadence. More often costs requests on a line
 * that may be struggling; much less often leaves a manager cashing up against
 * takings the cloud has not seen.
 *
 * Example crontab entry, on the box:
 *   * * * * * curl -fsS -H "Authorization: Bearer $BOX_CRON_SECRET" \
 *     http://localhost:4100/api/pos/box-flush
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────
 *
 * There is nobody signed in. Without BOX_CRON_SECRET set the route refuses
 * every request rather than running open: this posts real money to the books,
 * and an unauthenticated version of it would let anyone on the shop's LAN drive
 * that. Same rule and same reasoning as the reports and contracts ticks.
 */

function authorised(request: NextRequest): boolean {
  const secret = process.env.BOX_CRON_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization') ?? ''
  const offered = header.startsWith('Bearer ') ? header.slice(7) : header

  /* Constant time, and length-guarded first: timingSafeEqual throws on a length
     mismatch, which would itself leak the length. */
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Hands a batch to the cloud's posting path.
 *
 * ── IN-PROCESS, NOT OVER HTTP ─────────────────────────────────────────────
 *
 * The obvious shape is to POST /api/pos/sync, exactly as a device does. It was
 * rejected: that route authenticates with the till's session cookie, and there
 * is no cookie at 03:00 on a machine with nobody signed in. Minting a service
 * session for it would be a second way into the posting path, which is the one
 * place this codebase most wants a single door.
 *
 * `postOfflineSale` IS that door — the same function /api/pos/sync calls, per
 * sale, in the same order. Nothing about posting is reimplemented here.
 *
 * ── A THROW IS TRANSPORT; A RESULT IS ABOUT THE SALE ──────────────────────
 *
 * The distinction the outbox's retry policy rests on. `postOfflineSale` returns
 * a result for a sale it judged; it THROWS when the database blinked. So a
 * throw becomes BoxTransportError and stops the run with everything pending,
 * and a returned failure marks that one sale and lets the rest through.
 */
async function deliverInProcess(siteId: number, sales: OfflineSale[]): Promise<SyncSaleResult[]> {
  const results: SyncSaleResult[] = []

  for (const sale of sales) {
    try {
      results.push(await postOfflineSale(siteId, sale))
    } catch (error) {
      /*
       * The cloud is unreachable, or its database blinked. This says NOTHING
       * about the sales in the batch, so the whole run stops and everything
       * stays pending — marking twenty-five real sales failed because a
       * connection dropped is how a shop loses a day's takings.
       */
      throw new BoxTransportError(
        error instanceof Error ? error.message : 'The cloud could not be reached.',
        0,
      )
    }
  }

  return results
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const report: Record<string, unknown>[] = []

  for (const siteId of siteIds) {
    /* Only a hybrid site has a box. Everything else has no queue here to flush,
       and asking would mean connecting to a database that does not exist. */
    if (!(await tabsAreLocal(siteId))) continue

    try {
      let delivered = 0
      /* Batches until the queue is empty or a batch delivers nothing — the
         second guard is what stops a queue of permanently-failing sales from
         looping forever. */
      for (;;) {
        const accepted = await flushOnce(siteId, (sales) => deliverInProcess(siteId, sales))
        delivered += accepted
        if (accepted === 0) break
      }

      const pruned = await prune(siteId)
      const counts = await outboxCounts(siteId)
      report.push({ siteId, delivered, pruned, ...counts })
    } catch (error) {
      /*
       * Transport. Everything stays pending and the next run tries again — this
       * is the ordinary state of a shop whose line is down, not an incident.
       * Reported rather than thrown so one unreachable shop does not stop the
       * sweep for the others.
       */
      report.push({
        siteId,
        delivered: 0,
        blocked: error instanceof Error ? error.message : 'unreachable',
      })
    }
  }

  return NextResponse.json({ ok: true, sites: report })
}

/** Same work, for a cron that can only issue GETs. */
export async function GET(request: NextRequest) {
  return POST(request)
}

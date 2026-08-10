import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { applyDueSchedules } from '@/lib/site/priceSchedules'

/**
 * Scheduled price changes — call this every few minutes from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────
 *
 * Nobody is signed in at six in the morning, which is exactly when a new price
 * list is meant to take effect — the whole point is that the owner does not
 * have to be. The caller proves itself with a secret rather than a cookie, and
 * without PRICING_CRON_SECRET set the route refuses everything: an endpoint
 * that repriced a shop's entire catalogue while running wide open is not one to
 * leave open by accident.
 *
 * The same shape as the contracts, reports, baskets and storefront ticks — see
 * api/storefront/publish/route.ts. They agree deliberately: five heartbeats
 * that authorise five different ways is five chances to get one of them wrong.
 *
 * ── WHY THIS BEING LATE IS SURVIVABLE ────────────────────────────────────
 *
 * The tills do not wait for it. They carry the pending changes and switch on
 * their own clock at the exact minute, offline or not — see lib/priceSchedules.
 * This tick is what brings the DATABASE into line, so the reports, the online
 * store and the back office agree with what the terminals are already charging.
 *
 * That makes five minutes ample. It also means a missed run is not a crisis:
 * the sweep applies everything overdue on the next pass, and until it does the
 * shop is still trading at the right prices.
 *
 * Example crontab entry:
 *   *\/5 * * * * curl -fsS -H "Authorization: Bearer $PRICING_CRON_SECRET" \
 *     https://your-host/api/pricing/schedules/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites; a big catalogue change is a batched write per site. */
export const maxDuration = 300

export async function POST(request: NextRequest) {
  return handle(request)
}

// GET as well, because most cron services only issue GETs. The secret is what
// authorises the call either way.
export async function GET(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const secret = process.env.PRICING_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled pricing is not configured (PRICING_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let applied = 0
  let skipped = 0
  let prices = 0

  for (const siteId of siteIds) {
    try {
      const result = await applyDueSchedules(siteId)
      applied += result.applied
      skipped += result.skipped
      prices += result.prices
      // Only sites that did something. A quiet site is the normal case, and on
      // a five-minute cadence logging every one would be 288 empty lines a day
      // per shop.
      if (result.applied > 0 || result.skipped > 0) results.push({ siteId, ...result })
    } catch (e) {
      // One site's database being unreachable must not stop the others — the
      // whole point of a scheduled price change is that it happens without
      // anybody watching, so a single failure cannot stall the sweep.
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The pricing sweep failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    applied,
    skipped,
    prices,
    results,
  })
}

/**
 * Accepts the secret as a bearer token or an `?key=` parameter, since cron
 * services vary in what they can send. Compared in constant time so the
 * endpoint cannot be used as an oracle to recover the secret byte by byte.
 */
function authorised(request: NextRequest, secret: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const query = request.nextUrl.searchParams.get('key') ?? ''
  return safeEqual(bearer, secret) || safeEqual(query, secret)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — so the lengths are compared first and the result folded in.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

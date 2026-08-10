import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { publishDuePages } from '@/lib/site/storefrontPages'

/**
 * Scheduled page publishing — call this every few minutes from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────
 *
 * Nobody is signed in at midnight, which is exactly when a Black Friday page
 * is meant to go live. The caller proves itself with a secret rather than a
 * cookie, and without STOREFRONT_CRON_SECRET set the route refuses everything:
 * a publisher running wide open would let anyone push every shop's draft live.
 *
 * The same shape as the contracts and reports ticks — see
 * api/contracts/tick/route.ts. This is the third of these, and they agree
 * deliberately: three heartbeats that authorise three different ways is three
 * chances to get one of them wrong.
 *
 * ── WHY THE CADENCE IS MINUTES, NOT DAYS ─────────────────────────────────
 *
 * The other ticks bill and email on a date; this one fires at a TIME an owner
 * typed. "Live at 6am" that lands at 6pm is not a late publish, it is a
 * different day's trading. Every five minutes bounds the lateness to something
 * nobody notices, and the query it runs is an indexed lookup that is almost
 * always empty.
 *
 * Example crontab entry:
 *   *\/5 * * * * curl -fsS -H "Authorization: Bearer $STOREFRONT_CRON_SECRET" \
 *     https://your-host/api/storefront/publish
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites, each doing a handful of small writes. */
export const maxDuration = 120

export async function POST(request: NextRequest) {
  return handle(request)
}

// GET as well, because most cron services only issue GETs. The secret is what
// authorises the call either way.
export async function GET(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const secret = process.env.STOREFRONT_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled publishing is not configured (STOREFRONT_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let published = 0
  let skipped = 0

  for (const siteId of siteIds) {
    try {
      const result = await publishDuePages(siteId)
      published += result.published
      skipped += result.skipped
      // Only sites that did something. A quiet site is the normal case, and on
      // a five-minute cadence logging every one would be 288 empty lines a day
      // per shop.
      if (result.published > 0 || result.skipped > 0) results.push({ siteId, ...result })
    } catch (e) {
      // One site's database being unreachable must not stop the others — the
      // whole point of a scheduled publish is that it happens without anybody
      // watching, so a single failure cannot be allowed to stall the sweep.
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The publish sweep failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    published,
    skipped,
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

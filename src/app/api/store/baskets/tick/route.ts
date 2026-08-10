import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { remindAbandonedBaskets } from '@/lib/site/basketReminder'

/**
 * The abandoned-basket heartbeat — call this every 15–30 minutes from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────
 *
 * There is nobody signed in when a basket goes cold. The caller is a cron job,
 * so it proves itself with a secret rather than a cookie. Without
 * BASKET_CRON_SECRET set this refuses every request: a sweep that ran wide open
 * would be a way for anyone to trigger mail to every shopper who ever saved a
 * basket.
 *
 * ── IT NEEDS A PUBLIC_PREFIXES ENTRY ─────────────────────────────────────
 *
 * proxy.ts guards `/api` as well as pages. Without `/api/store/baskets/tick`
 * listed there this route answers a 307 to the login page and the sweep
 * silently never runs — the same failure the reports and contracts ticks have
 * comments about, which is exactly why this one has this comment.
 *
 * ── WHY IT IS SAFE TO CALL OFTEN ─────────────────────────────────────────
 *
 * Every basket is claimed with `reminded_at` before its email is attempted, so
 * calling this twice a minute sends nothing twice. Calling it rarely is the
 * gentler failure: a reminder that arrives late is still useful, whereas one
 * that arrives twice is the thing this whole feature is designed not to do.
 *
 * Example crontab entry:
 *   *\/20 * * * * curl -fsS -H "Authorization: Bearer $BASKET_CRON_SECRET" \
 *     https://your-host/api/store/baskets/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites can outlast the default serverless budget. */
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
  const secret = process.env.BASKET_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Basket reminders are not configured (BASKET_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let sent = 0
  let failed = 0

  for (const siteId of siteIds) {
    try {
      const result = await remindAbandonedBaskets(siteId)
      sent += result.sent
      failed += result.failed
      // Only report sites that actually did something. Nearly every shop has
      // this switched off, and logging a zero for each one every 20 minutes
      // buries the events worth seeing.
      if (result.attempted > 0) results.push({ siteId, ...result })
    } catch (e) {
      failed++
      // One site's database being unreachable must not stop the others.
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The basket sweep failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    sent,
    failed,
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

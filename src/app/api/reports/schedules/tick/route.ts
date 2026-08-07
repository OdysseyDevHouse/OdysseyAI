import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { tickSite } from '@/lib/reportSchedules/tick'

/**
 * The scheduler's heartbeat — call this every few minutes from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────────
 *
 * There is nobody signed in at 07:00. The caller is a cron job, so it proves
 * itself with a secret rather than a cookie. Without REPORT_CRON_SECRET set the
 * route refuses every request: a scheduler that silently ran wide open would be
 * a way for anyone to trigger mail to every recipient on every rule.
 *
 * ── WHY IT IS SAFE TO CALL OFTEN ─────────────────────────────────────────────
 *
 * Every occurrence is claimed in the run ledger before it is sent, so calling
 * this twice a minute sends nothing twice. Calling it rarely is the real risk:
 * an occurrence more than a few hours late is skipped rather than sent, because
 * a report that arrives long after its moment reads as current and gets acted
 * on. Every five minutes is a good cadence.
 *
 * Example crontab entry:
 *   *\/5 * * * * curl -fsS -H "Authorization: Bearer $REPORT_CRON_SECRET" \
 *     https://your-host/api/reports/schedules/tick
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
  const secret = process.env.REPORT_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Scheduled reports are not configured (REPORT_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const now = new Date()
  const siteIds = await activeSiteIds()

  const results: Record<string, unknown>[] = []
  let sent = 0
  let failed = 0

  for (const siteId of siteIds) {
    try {
      const result = await tickSite(siteId, now)
      sent += result.sent
      failed += result.failed
      // Only report sites that actually did something — a quiet site is the
      // normal case and logging it every five minutes buries the real events.
      if (result.claimed > 0) results.push({ siteId, ...result })
    } catch (e) {
      failed++
      // One site's database being unreachable must not stop the others.
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The tick failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: now.toISOString(),
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

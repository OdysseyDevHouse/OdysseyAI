import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { sendLowStockDigest } from '@/lib/site/lowStockAlert'

/**
 * The alerts heartbeat — call this every hour or so.
 *
 * One job rides it today: the low-stock digest. Its own secret rather than
 * the basket one, so a shop can rotate either without breaking the other.
 *
 * ── IT NEEDS A PUBLIC_PREFIXES ENTRY ─────────────────────────────────────
 *
 * proxy.ts guards /api as well as pages. Without `/api/alerts/tick` listed
 * there this answers a 307 to the login page and the digest silently never
 * sends — the same failure the other ticks carry this comment about. The
 * failure mode of THIS route going quiet is that nobody is told stock ran
 * out; its success state is also silence, which is why the runbook says to
 * watch the JSON, not the inbox.
 *
 * Safe to call often: sendLowStockDigest stamps last_sent BEFORE sending,
 * so frequency changes latency, never volume.
 *
 * Example crontab entry:
 *   0 * * * * curl -fsS -H "Authorization: Bearer $LOW_STOCK_CRON_SECRET" \
 *     https://your-host/api/alerts/tick
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  return handle(request)
}

// GET as well, because most cron services only issue GETs.
export async function GET(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const secret = process.env.LOW_STOCK_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Alerts are not configured (LOW_STOCK_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }
  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let sent = 0

  for (const siteId of siteIds) {
    try {
      const result = await sendLowStockDigest(siteId)
      if (result.sent) sent++
      // Quiet sites stay out of the response — 'off' and 'not_due' every
      // hour would bury the one row worth reading.
      if (result.sent || result.error) results.push({ siteId, ...result })
    } catch (e) {
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The digest failed for this site.',
      })
    }
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), sites: siteIds.length, sent, results })
}

function authorised(request: NextRequest, secret: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const query = request.nextUrl.searchParams.get('key') ?? ''
  return safeEqual(bearer, secret) || safeEqual(query, secret)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

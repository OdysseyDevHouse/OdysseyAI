import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { deliverDue } from '@/lib/site/webhooks'

/**
 * The webhook delivery heartbeat — call this every minute or five.
 *
 * Producers only ENQUEUE (a local insert riding the event's own commit); this
 * tick is what actually sends, with retries on the backoff ladder. Delivery
 * lag therefore equals the tick interval — stated plainly rather than hidden.
 *
 * ── IT NEEDS A PUBLIC_PREFIXES ENTRY ─────────────────────────────────────
 *
 * proxy.ts guards /api as well as pages. Without `/api/webhooks/tick` listed
 * there this answers a 307 to the login page and every delivery quietly waits
 * forever. Its own secret, WEBHOOK_CRON_SECRET, so a shop can rotate it
 * without touching the other ticks.
 *
 * Safe to call often: deliverDue only touches rows whose next_attempt_at has
 * arrived, so frequency changes latency, never volume.
 *
 * Example crontab entry:
 *   * * * * * curl -fsS -H "Authorization: Bearer $WEBHOOK_CRON_SECRET" \
 *     https://your-host/api/webhooks/tick
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
  const secret = process.env.WEBHOOK_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Webhook delivery is not configured (WEBHOOK_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }
  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let delivered = 0

  for (const siteId of siteIds) {
    try {
      const outcome = await deliverDue(siteId)
      delivered += outcome.delivered
      // Quiet sites stay out of the response.
      if (outcome.attempted > 0) results.push({ siteId, ...outcome })
    } catch (e) {
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'Delivery failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    delivered,
    results,
  })
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

import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { sendLowStockDigest } from '@/lib/site/lowStockAlert'

/**
 * The alerts heartbeat — call this every hour or so.
 *
 * THREE jobs ride it: the alert rules, the low-stock digest, and SLA
 * escalation (164). One secret rather than the basket one, so a shop can rotate
 * either without breaking the other — and one route rather than three, because
 * every job wants the same hourly cadence and the same per-site try/catch.
 *
 * ── THE RULES AND THE DIGEST BOTH STAY ───────────────────────────────────
 *
 * A `low_stock` alert rule is the digest's richer successor — per recipient,
 * over four channels, and able to draft the orders. But the standalone digest
 * is configured and working on sites today, and switching it off underneath
 * them would stop an email somebody relies on without asking. They coexist:
 * a shop that builds a rule can clear low_stock_alert_email itself.
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

  let escalated = 0
  let fired = 0

  for (const siteId of siteIds) {
    /*
     * The alert rules — the biggest of the three jobs, and first, because a
     * rule is a thing somebody deliberately asked for.
     *
     * Its own try/catch like the others: a site whose rules throw must not
     * stop the digest for every site after it. tickSite never throws for a
     * single BAD RULE (it records the failure on that rule's ledger row and
     * carries on) — this catches the site-wide failures instead, an
     * unreachable database or a schema that has not been migrated.
     *
     * Safe to call often, and this is the one that has to be: the run ledger's
     * UNIQUE (rule_id, due_at) means an occurrence is claimed exactly once, so
     * calling hourly changes how promptly somebody hears, never how many times.
     */
    try {
      const { tickSite } = await import('@/lib/alerts/tick')
      const alerts = await tickSite(siteId)
      if (alerts.claimed > 0) {
        fired += alerts.fired
        results.push({ siteId, alerts })
      }
    } catch (e) {
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'The alert rules failed for this site.',
      })
    }

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

    /*
     * SLA escalation (164) — a SECOND job on this tick rather than a third
     * route and a third secret.
     *
     * Its own try/catch, deliberately: a site whose escalation sweep throws
     * must not stop the low-stock digest for every site after it, and the two
     * jobs share nothing but the heartbeat.
     *
     * Safe to call often for the same reason the digest is: escalateOverdue
     * claims a row per (job, kind) BEFORE notifying, so frequency changes how
     * quickly somebody hears, never how many times.
     */
    try {
      const { escalateOverdue } = await import('@/lib/site/jobSla')
      const sla = await escalateOverdue(siteId)
      if (sla.escalated > 0) {
        escalated += sla.escalated
        results.push({ siteId, escalated: sla.escalated })
      }
    } catch (e) {
      results.push({
        siteId,
        error: e instanceof Error ? e.message : 'SLA escalation failed for this site.',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    sites: siteIds.length,
    sent,
    escalated,
    fired,
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

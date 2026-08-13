import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { runAutomations } from '@/lib/site/jobAutomations'

/**
 * The heartbeat for the three time-based job automations.
 *
 * Escalate a breached SLA, remind a technician the evening before a visit, and
 * raise the draft invoice on a closed job. Section 12 of the PRD asked for a
 * workflow engine; the plan argued that out in favour of named rules, and these
 * are the three of the six that a clock fires rather than a person.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────────
 *
 * There is no logged-in user at 05:20. The caller authenticates with a secret
 * rather than a cookie. Without JOB_AUTOMATION_CRON_SECRET set this returns 503
 * and does NOTHING — it does not fall back to running openly. An endpoint that
 * escalates and invoices must never be reachable by anybody who finds the URL.
 *
 * ── WHY THIS IS ITS OWN SECRET ───────────────────────────────────────────────
 *
 * Not shared with JOB_SERIES_CRON_SECRET, even though the mechanism is identical.
 * One secret across every tick means rotating it for one reason silently breaks
 * the others, and a leak of one is a leak of all.
 *
 * ── IT MUST BE IN PUBLIC_EXACT ───────────────────────────────────────────────
 *
 * proxy.ts guards api/ routes too. Without an entry there this route 307s to the
 * login page and a cron service records a perfectly successful fetch of an HTML
 * page, forever — the failure mode that looks like success.
 *
 * Suggested schedule (after the working day starts, so a breach is escalated
 * while somebody can still act on it):
 *
 *   20 5 * * * curl -fsS -H "Authorization: Bearer $JOB_AUTOMATION_CRON_SECRET" \
 *     https://example.com/api/jobs/automations/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites, some of it raising invoices, is not quick. */
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
  const secret = process.env.JOB_AUTOMATION_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Job automations are not configured (JOB_AUTOMATION_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let done = 0
  let failed = 0

  for (const siteId of siteIds) {
    try {
      const outcomes = await runAutomations(siteId)
      const acted = outcomes.filter((o) => o.claimed > 0 || o.failed > 0)
      outcomes.forEach((o) => {
        done += o.done
        failed += o.failed
      })
      // Only report sites that actually did something. A quiet site is the normal
      // case and logging it every morning buries the real events.
      if (acted.length > 0) {
        results.push({
          siteId,
          events: acted.map((o) => ({
            event: o.event,
            claimed: o.claimed,
            done: o.done,
            failed: o.failed,
          })),
        })
      }
    } catch (error) {
      /*
       * One site failing must not stop the others. This earned itself on the
       * series tick, where site 2 was six migrations behind and the sweep
       * completed and reported it rather than dying on the first failure.
       */
      failed++
      results.push({
        siteId,
        error: error instanceof Error ? error.message : 'Unknown failure',
      })
    }
  }

  return NextResponse.json({ ok: true, sites: siteIds.length, done, failed, results })
}

/**
 * Accepts the secret as a bearer token or an `?key=` parameter, since cron
 * services vary in what they can send. Compared in constant time so the endpoint
 * cannot be used as an oracle to recover the secret byte by byte.
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

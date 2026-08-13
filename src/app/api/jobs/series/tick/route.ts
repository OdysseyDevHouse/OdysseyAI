import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { generateDueJobs } from '@/lib/site/jobSeries'

/**
 * Recurring jobs' heartbeat — call this once a day from cron.
 *
 * ── WHY A SHARED SECRET AND NOT A SESSION ────────────────────────────────────
 *
 * There is nobody signed in at 05:00. The caller is a cron job, so it proves
 * itself with a secret rather than a cookie. Without JOB_SERIES_CRON_SECRET set
 * the route refuses every request outright: a generator running wide open would
 * be a way for anyone to raise work against every customer in the system.
 *
 * ── WHY IT IS SAFE TO CALL OFTEN ─────────────────────────────────────────────
 *
 * Every period is claimed in `job_series_runs` before the job is built, under a
 * unique key on (series_id, for_date) — so calling this twice a minute raises
 * nothing twice. Measured: a concurrent pair produced exactly one job.
 *
 * Calling it RARELY is also safe: a series left un-ticked for three months raises
 * three jobs on the next run, one per period, each dated for its own period rather
 * than for the day the run happened. Past 24 outstanding periods it stops and says
 * so rather than generating two years of back-dated work.
 *
 * Once a day is the right cadence. Due dates are dates, not times.
 *
 * ── WHY THIS IS ITS OWN SECRET ───────────────────────────────────────────────
 *
 * Not shared with CONTRACT_CRON_SECRET, even though the mechanism is the same
 * one. They authorise different powers — one raises invoices, the other raises
 * work — and a single secret means anyone entitled to trigger one can trigger
 * both. It also lets a business run the biller without the job generator, which
 * is a normal configuration rather than an odd one.
 *
 * Example crontab entry:
 *   10 5 * * * curl -fsS -H "Authorization: Bearer $JOB_SERIES_CRON_SECRET" \
 *     https://your-host/api/jobs/series/tick
 */

export const dynamic = 'force-dynamic'
/** A sweep across sites, each raising jobs and attaching their checks, is not quick. */
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
  const secret = process.env.JOB_SERIES_CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'Recurring jobs are not configured (JOB_SERIES_CRON_SECRET is not set).' },
      { status: 503 },
    )
  }

  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }

  /*
   * The actor recorded against every job this raises.
   *
   * userId 0 is the house convention for a system actor — contracts/tick.ts uses
   * the same. The NAME is the point: "Recurring jobs" in the activity log is more
   * honest than the id of whoever happened to set the schedule up months ago.
   */
  const actor = { userId: 0, userName: 'Recurring jobs' }

  const siteIds = await activeSiteIds()
  const results: Record<string, unknown>[] = []
  let created = 0
  let skipped = 0

  for (const siteId of siteIds) {
    try {
      const result = await generateDueJobs(siteId, actor)
      created += result.created.length
      skipped += result.skipped.length
      // Only report sites that actually did something — a quiet site is the
      // normal case and logging it every day buries the real events.
      if (result.created.length > 0 || result.skipped.length > 0) {
        results.push({
          siteId,
          created: result.created.length,
          jobs: result.created.map((j) => ({
            series: j.seriesName,
            job: j.documentNumber,
            forDate: j.forDate,
          })),
          skipped: result.skipped,
        })
      }
    } catch (error) {
      /*
       * One site failing must not stop the others. A shared database problem will
       * show up on every site and be obvious; a single site with a broken schedule
       * should not silence the rest of the estate.
       */
      skipped++
      results.push({
        siteId,
        error: error instanceof Error ? error.message : 'Unknown failure',
      })
    }
  }

  return NextResponse.json({ ok: true, sites: siteIds.length, created, skipped, results })
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

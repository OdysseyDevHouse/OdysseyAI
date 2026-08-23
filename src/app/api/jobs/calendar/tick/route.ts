import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { activeSiteIds } from '@/lib/sites'
import { pullAllCalendars } from '@/lib/site/jobCalendar'

/**
 * Reading linked calendars back: busy time, and anything somebody moved.
 *
 * ── WHY A POLL AND NOT A WEBHOOK ────────────────────────────────────────────
 *
 * Both providers offer push notifications, and both require a publicly
 * reachable HTTPS endpoint that they can verify — which a shop running this on
 * its own machine behind a router does not have. A webhook that works for
 * hosted sites and silently never fires for local ones is worse than a poll
 * that works the same everywhere, because the failure is invisible.
 *
 * The cost is latency: a dragged event is noticed at the next tick rather than
 * within seconds. For a proposal a human has to decide anyway, that is fine.
 *
 * ── ITS OWN SECRET ──────────────────────────────────────────────────────────
 *
 * Not shared with JOB_AUTOMATION_CRON_SECRET or JOB_SERIES_CRON_SECRET, for the
 * reason those two state: one secret across every tick means rotating it for
 * one reason silently breaks the others, and a leak of one is a leak of all.
 *
 * Without JOB_CALENDAR_CRON_SECRET set this returns 503 and does NOTHING. It
 * does not fall back to running openly.
 *
 * ── IT MUST BE IN PUBLIC_EXACT ──────────────────────────────────────────────
 *
 * proxy.ts guards api/ routes too. Without an entry there this 307s to the login
 * page and a cron service records a perfectly successful fetch of an HTML page,
 * forever — the failure mode that looks like success.
 *
 * Suggested schedule (every fifteen minutes through the working day; a calendar
 * has no deadline measured in seconds and both providers rate-limit):
 *
 *   *\/15 6-18 * * * curl -fsS -H "Authorization: Bearer $JOB_CALENDAR_CRON_SECRET" \
 *     https://example.com/api/jobs/calendar/tick
 */
export async function GET(request: NextRequest) {
  const expected = process.env.JOB_CALENDAR_CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'JOB_CALENDAR_CRON_SECRET is not configured.' },
      { status: 503 },
    )
  }

  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(expected)
  // Length-checked first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length is not the secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  const sites = await activeSiteIds()
  let pulled = 0
  for (const siteId of sites) {
    /*
     * Sequentially, and swallowing per site.
     *
     * One site whose provider is unreachable must not stop the other twenty
     * one, and pullAllCalendars is itself sequential per account because both
     * providers rate-limit per application — twenty technicians' calendars
     * fetched at once is how a business earns a 429 that fails all twenty.
     */
    pulled += await pullAllCalendars(siteId).catch(() => 0)
  }

  return NextResponse.json({ ok: true, sites: sites.length, accounts: pulled })
}

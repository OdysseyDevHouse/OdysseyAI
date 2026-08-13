import { NextResponse, type NextRequest } from 'next/server'
import { readCalendarToken } from '@/lib/calendarToken'
import { siteQuery } from '@/lib/siteDb'
import { buildIcs, type IcsEvent } from '@/lib/icsFeed'
import type { RowDataPacket } from 'mysql2/promise'

/**
 * A technician's visits, as a calendar feed.
 *
 * ── WHY A FEED AND NOT TWO-WAY SYNC ─────────────────────────────────────────
 *
 * The PRD asks for Google and Outlook integration. Two-way sync needs OAuth
 * token storage per user per site, webhook receipt, delete-tombstoning, and an
 * answer to "which side wins" that the PRD itself spends four pages failing to
 * settle. This is the ninety per cent: a technician subscribes once and their
 * own phone shows their day, in whatever calendar app they already use.
 *
 * It is READ-ONLY by construction. There is no write path at all, so the
 * question of a technician deleting an event and cancelling a job cannot arise —
 * deleting the event unsubscribes them from a row that will simply come back.
 *
 * ── WHY IT IS PUBLIC, AND WHAT THAT COSTS ───────────────────────────────────
 *
 * A calendar service fetches with no cookie and no browser, so the URL is the
 * credential. The token is signed and names one user on one site; the query
 * reads only that user's appointments, so a forged token cannot widen what it
 * sees even if the signature were broken.
 *
 * The feed deliberately carries NO financial data — no prices, no costs, no
 * margins. A leaked URL exposes where somebody will be, which is the trade every
 * calendar-feed product makes, and rotating SESSION_SECRET revokes every feed at
 * once.
 *
 * ── IT MUST BE IN PUBLIC_EXACT ──────────────────────────────────────────────
 *
 * proxy.ts guards api/ routes. Without an entry there, a calendar service
 * fetches the login page forever and renders an empty calendar with no error —
 * the failure that looks like "no jobs booked".
 */

export const dynamic = 'force-dynamic'

type Row = RowDataPacket & Record<string, unknown>

/** How far ahead and behind the feed reaches. */
const DAYS_BACK = 30
const DAYS_AHEAD = 180

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // A .ics suffix is what makes some calendar apps accept the URL at all, so it
  // is tolerated and stripped rather than rejected.
  const claim = await readCalendarToken(token.replace(/\.ics$/i, ''))
  if (!claim) {
    // 404 rather than 401: an invalid token should look like a URL that does not
    // exist, not like one that would work with the right credential.
    return new NextResponse('Not found', { status: 404 })
  }

  let rows: Row[] = []
  let userName = 'Jobs'
  try {
    const [appointments, user] = await Promise.all([
      siteQuery<Row>(
        claim.siteId,
        `SELECT a.id, a.starts_at, a.duration_minutes, a.status, a.notes,
                j.id AS job_id, j.document_number, j.title, j.customer_name,
                sa.name AS address_name, sa.address_line1, sa.city
           FROM job_card_appointments a
           JOIN job_appointment_assignees ass ON ass.appointment_id = a.id
           JOIN job_cards j ON j.id = a.job_card_id
           LEFT JOIN service_addresses sa ON sa.id = a.service_address_id
          WHERE ass.user_id = ?
            AND a.starts_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND a.starts_at <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
          ORDER BY a.starts_at
          LIMIT 500`,
        [claim.userId, DAYS_BACK, DAYS_AHEAD],
      ),
      siteQuery<Row>(claim.siteId, `SELECT name FROM users WHERE id = ? LIMIT 1`, [claim.userId]),
    ])
    rows = appointments
    if (user[0]?.name) userName = String(user[0].name)
  } catch {
    /*
     * An empty calendar rather than an error.
     *
     * A calendar service that gets a 500 may back off for hours or stop polling
     * altogether, and the technician sees nothing and is told nothing. An empty
     * but valid feed keeps the subscription alive until whatever broke is fixed.
     */
    rows = []
  }

  const events: IcsEvent[] = rows.map((r) => {
    /*
     * The driver hands back a Date whose UTC parts ARE the stored wall clock —
     * the pool sets the connection timezone to 'Z'. So an 08:00 booking arrives
     * as 08:00 UTC, which is exactly what the feed should publish.
     */
    const start = r.starts_at as Date
    const minutes = Number(r.duration_minutes ?? 60) || 60
    const end = new Date(start.getTime() + minutes * 60_000)

    const number = r.document_number === null ? `#${Number(r.job_id)}` : String(r.document_number)
    const customer = r.customer_name === null ? null : String(r.customer_name)

    const where = [r.address_name, r.address_line1, r.city]
      .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
      .map((part) => String(part).trim())
      .join(', ')

    const status = String(r.status)

    return {
      /*
       * Stable, and derived only from ids that never change. A UID that moved
       * when a visit was edited would leave the subscriber holding both the old
       * event and the new one.
       *
       * The site is in it so two sites cannot collide in a calendar somebody
       * subscribes to both from.
       */
      uid: `job-visit-${claim.siteId}-${Number(r.id)}@odyssey`,
      startsAt: start,
      endsAt: end,
      // The customer leads: a technician scanning their week is looking for who,
      // not for a job number.
      summary: customer ? `${customer} — ${String(r.title)}` : String(r.title),
      description: [number, r.notes === null ? null : String(r.notes)]
        .filter(Boolean)
        .join('\n'),
      location: where || undefined,
      /*
       * A cancelled visit is published as CANCELLED rather than dropped.
       *
       * Dropping it would leave the booking sitting in a subscriber's calendar
       * for ever — a calendar only removes an event it is told about, and a row
       * that vanishes from the feed is simply not mentioned again. So the
       * technician would drive to a call that was called off.
       */
      status:
        status === 'cancelled' || status === 'no_show'
          ? 'CANCELLED'
          : status === 'scheduled'
            ? 'TENTATIVE'
            : 'CONFIRMED',
    }
  })

  const body = buildIcs(events, {
    name: `${userName} — jobs`,
    stampedAt: new Date(),
  })

  return new NextResponse(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      // Named so a manual download lands as a recognisable file.
      'content-disposition': 'inline; filename="jobs.ics"',
      // Never cached: the whole point is that a subscriber sees today's changes.
      'cache-control': 'no-store, max-age=0',
    },
  })
}

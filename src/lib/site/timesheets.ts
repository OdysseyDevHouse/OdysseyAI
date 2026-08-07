import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { toNum } from '../decimals'
import { buildTimesheet, canApprove, type PersonTimesheet } from '../timesheetModel'
import { BCEA_ORDINARY_HOURS_PW } from '../employmentModel'
import { entriesBetween } from './staffTime'
import { holidayDatesFor } from './holidays'

export type { PersonTimesheet } from '../timesheetModel'

/**
 * Timesheets — the hours, grouped and banded, for somebody to sign off.
 *
 * Assembles rather than stores. A timesheet is a VIEW of `staff_time_entries`
 * over a date range, so correcting an entry corrects every sheet it appears on
 * without anything needing to be rebuilt. What IS stored is the approval, on
 * the entries themselves.
 */

/**
 * Everyone's hours for a range.
 *
 * `ordinary_hours_pw` comes from each person's own employment row — a
 * part-timer's overtime starts at their week, not at 45. Anyone without an
 * employment row falls back to the BCEA maximum, which is the conservative
 * choice: it under-reports overtime rather than inventing it.
 */
export async function timesheetsFor(
  siteId: number,
  from: string,
  to: string,
  userId?: number,
): Promise<PersonTimesheet[]> {
  const entries = await entriesBetween(siteId, from, to, userId)

  const employment = await siteQuery<
    RowDataPacket & { user_id: number; ordinary_hours_pw: string | number }
  >(siteId, 'SELECT user_id, ordinary_hours_pw FROM user_employment')
  const hoursByUser = new Map(
    employment.map((e) => [e.user_id, toNum(e.ordinary_hours_pw, BCEA_ORDINARY_HOURS_PW)]),
  )

  // Everyone who worked, plus the person asked about even if they did not —
  // an empty sheet is a real answer, and "no rows" reads as a broken screen.
  const people = new Map<number, string>()
  for (const entry of entries) people.set(entry.userId, entry.userName)

  if (userId && !people.has(userId)) {
    const named = await siteQuery<RowDataPacket & { id: number; name: string }>(
      siteId,
      'SELECT id, name FROM users WHERE id = ? LIMIT 1',
      [userId],
    )
    if (named.length) people.set(named[0].id, named[0].name)
  }

  const holidays = await publicHolidays(siteId, from, to)

  return [...people.entries()]
    .map(([id, name]) =>
      buildTimesheet(
        id,
        name,
        entries.filter((e) => e.userId === id),
        from,
        to,
        hoursByUser.get(id) ?? BCEA_ORDINARY_HOURS_PW,
        holidays,
      ),
    )
    .sort((a, b) => a.userName.localeCompare(b.userName))
}

/**
 * The public holidays this store observes, as dates.
 *
 * Was computed inline here, with the ten fixed-date holidays only and a note
 * explaining that Good Friday and Family Day were absent because "a wrong
 * Easter is worse than an absent one". The caution was right; the conclusion
 * was too cautious. Easter is defined by an exact algorithm rather than
 * approximated — see `holidayModel.ts` — and absent, those two days banded as
 * ordinary hours and underpaid anybody working the Easter weekend.
 *
 * Now delegates: `holidayModel.ts` computes the statutory calendar, and
 * `site/holidays.ts` applies whatever this store has said differs.
 */
const publicHolidays = holidayDatesFor

export type ApprovalResult = { ok: true; approved: number } | { ok: false; error: string }

/**
 * Signs off everything a person worked in a range.
 *
 * Refuses while any entry is still open: approving a shift that has not ended
 * would freeze a figure that is still moving, and the entry then cannot be
 * corrected because approval locks it.
 */
export async function approveRange(
  siteId: number,
  userId: number,
  from: string,
  to: string,
  actor: { userId: number; userName: string },
): Promise<ApprovalResult> {
  const [sheet] = await timesheetsFor(siteId, from, to, userId)
  if (!sheet) return { ok: false, error: 'There is nothing to approve.' }

  const allowed = canApprove(sheet)
  if (!allowed.ok) return { ok: false, error: allowed.reason ?? 'That cannot be approved.' }

  const result = await siteExecute(
    siteId,
    `UPDATE staff_time_entries
        SET approved_at = NOW(), approved_by_user_id = ?, approved_by_name = ?
      WHERE user_id = ?
        AND approved_at IS NULL
        AND ended_at IS NOT NULL
        AND started_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND ended_at >= ?`,
    [actor.userId, actor.userName, userId, to, from],
  )

  return { ok: true, approved: result.affectedRows }
}

/**
 * Takes an approval back off, so a mistake can be corrected.
 *
 * Deliberately available rather than final: a sheet approved with somebody's
 * Saturday missing has to be fixable, and the alternative is a manager editing
 * the database. The activity log records who reopened it.
 */
export async function unapproveRange(
  siteId: number,
  userId: number,
  from: string,
  to: string,
): Promise<ApprovalResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE staff_time_entries
        SET approved_at = NULL, approved_by_user_id = NULL, approved_by_name = NULL
      WHERE user_id = ?
        AND approved_at IS NOT NULL
        AND started_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND (ended_at IS NULL OR ended_at >= ?)`,
    [userId, to, from],
  )
  return { ok: true, approved: result.affectedRows }
}

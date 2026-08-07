import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { effectiveHolidays, holidayDates, type Holiday } from '../holidayModel'

/**
 * Public holidays for a site: the statutory calendar, plus whatever the store
 * has said differs.
 *
 * The calendar itself is computed — see `holidayModel.ts`. This module adds
 * only the store's own overrides from `public_holidays` (migration 063) and
 * the queries that read them.
 */

export type HolidayOverride = {
  id: number
  date: string
  name: string
  /** True means "not a holiday here", overriding a computed one. */
  isWorkingDay: boolean
  note: string | null
  createdByName: string | null
}

type Row = RowDataPacket & {
  id: number
  holiday_date: string | Date
  name: string
  is_working_day: number
  note: string | null
  created_by_name: string | null
}

/** MySQL hands back a Date for a DATE column, and only the day matters. */
function asDate(value: string | Date): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
}

function mapRow(r: Row): HolidayOverride {
  return {
    id: r.id,
    date: asDate(r.holiday_date),
    name: r.name,
    isWorkingDay: r.is_working_day === 1,
    note: r.note,
    createdByName: r.created_by_name,
  }
}

/**
 * The store's overrides in a range.
 *
 * A missing `public_holidays` table returns nothing rather than throwing: a
 * site that has not run 063 must still be able to open a timesheet, and the
 * statutory calendar is the correct answer there anyway. Schema drifts between
 * sites, so this is the ordinary case rather than a defensive flourish.
 */
export async function holidayOverrides(
  siteId: number,
  from: string,
  to: string,
): Promise<HolidayOverride[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, holiday_date, name, is_working_day, note, created_by_name
         FROM public_holidays
        WHERE holiday_date BETWEEN ? AND ?
        ORDER BY holiday_date`,
      [from, to],
    )
    return rows.map(mapRow)
  } catch {
    return []
  }
}

/** The calendar a store actually observes, statutory days included. */
export async function holidaysFor(
  siteId: number,
  from: string,
  to: string,
): Promise<Holiday[]> {
  return effectiveHolidays(from, to, await holidayOverrides(siteId, from, to))
}

/** Just the dates, which is what timesheet banding needs. */
export async function holidayDatesFor(
  siteId: number,
  from: string,
  to: string,
): Promise<ReadonlySet<string>> {
  return holidayDates(await holidaysFor(siteId, from, to))
}

export type HolidaySaveResult = { ok: true } | { ok: false; error: string }

/**
 * Adds or replaces a store's ruling on one day.
 *
 * Upsert on the date, because the unique key is the date: a store correcting
 * what it said about the 24th means to change that ruling, not to hold two.
 */
export async function saveHolidayOverride(
  siteId: number,
  input: { date: string; name: string; isWorkingDay: boolean; note: string | null },
  actor: { userId: number; userName: string },
): Promise<HolidaySaveResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: 'Enter a date as yyyy-mm-dd.' }
  }
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the day a name, so a timesheet can explain itself.' }
  if (name.length > 120) return { ok: false, error: 'That name is too long.' }

  await siteExecute(
    siteId,
    `INSERT INTO public_holidays
       (holiday_date, name, is_working_day, note, created_by_user_id, created_by_name)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       is_working_day = VALUES(is_working_day),
       note = VALUES(note),
       created_by_user_id = VALUES(created_by_user_id),
       created_by_name = VALUES(created_by_name)`,
    [
      input.date,
      name,
      input.isWorkingDay ? 1 : 0,
      input.note?.trim() || null,
      actor.userId,
      actor.userName,
    ],
  )
  return { ok: true }
}

/**
 * Removes a ruling, so the statutory calendar applies again.
 *
 * Deleting an override is not deleting a holiday — a computed day comes back
 * the moment the row saying otherwise goes away, which is the intended way to
 * undo a mistake.
 */
export async function deleteHolidayOverride(
  siteId: number,
  id: number,
): Promise<HolidaySaveResult> {
  await siteExecute(siteId, 'DELETE FROM public_holidays WHERE id = ?', [id])
  return { ok: true }
}

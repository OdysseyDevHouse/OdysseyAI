/**
 * Time-entry facts shared by the server and the browser.
 *
 * Not `server-only`. The clock screen counts up on the client while somebody
 * is on shift, and the timesheet formats the same durations the server totals
 * — both need this arithmetic, and importing it from `site/staffTime.ts` would
 * drag mysql2 into the browser bundle. Same split as `employmentModel.ts`.
 */

export type TimeSource = 'pin' | 'manual' | 'import'

export type TimeEntry = {
  id: number
  userId: number
  userName: string
  startedAt: string
  endedAt: string | null
  source: TimeSource
  terminalId: number | null
  shiftId: number | null
  breakMinutes: number
  note: string | null
  editedByName: string | null
  editedReason: string | null
  approvedAt: string | null
  /** Worked minutes, net of the break. Null while still on the clock. */
  minutes: number | null
}

/**
 * How long a shift may run before it is treated as a forgotten clock-out.
 *
 * Twelve hours is deliberately generous — a stocktake night or a December
 * Saturday genuinely runs long, and refusing those would train people to work
 * around the system. What it catches is the entry left open overnight, which is
 * the common case and the one that silently inflates somebody's hours.
 */
export const LONG_SHIFT_HOURS = 12

/** Whole minutes between two instants, never negative. */
export function minutesBetween(from: Date | string, to: Date | string): number {
  const a = typeof from === 'string' ? new Date(from) : from
  const b = typeof to === 'string' ? new Date(to) : to
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000))
}

/**
 * Worked minutes for one entry, net of the unpaid break.
 *
 * Floors at zero: a break longer than the shift is a data-entry mistake, and
 * negative worked time would quietly subtract from the day's total rather than
 * showing up as the error it is.
 */
export function workedMinutes(
  startedAt: string,
  endedAt: string | null,
  breakMinutes: number,
): number | null {
  if (!endedAt) return null
  return Math.max(0, minutesBetween(startedAt, endedAt) - Math.max(0, breakMinutes))
}

/** "7h 32m", the way a timesheet reads it. Handles zero and null. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes === 0) return '0h'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** Decimal hours, for costing. 7h 30m → 7.5. */
export function toHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100
}

/** "07:58", in the browser's own timezone. */
export function formatClock(at: string | null): string {
  if (!at) return '—'
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Whether an open entry has been running long enough to look forgotten. */
export function looksForgotten(startedAt: string, now = new Date()): boolean {
  return minutesBetween(startedAt, now) > LONG_SHIFT_HOURS * 60
}

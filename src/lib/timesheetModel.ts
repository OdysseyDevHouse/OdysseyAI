/**
 * Timesheet arithmetic, shared by the server and the browser.
 *
 * Not `server-only`: the timesheet screen totals the same rows the server
 * totals, and the two disagreeing would be worse than either being wrong.
 * Same split as `employmentModel.ts` and `timeModel.ts`.
 */

import { toHours, type TimeEntry } from './timeModel'

/**
 * BCEA overtime multipliers.
 *
 * Section 10: overtime is paid at one and a half times ordinary pay.
 * Section 16: work on a Sunday is paid at double, unless the person
 * ordinarily works Sundays — in which case it is one and a half.
 *
 * SURFACED, NOT SILENTLY APPLIED. Many stores have agreements that differ, and
 * a system that quietly multiplied a Sunday by two would produce a payroll
 * figure nobody could reconcile against what they actually agreed to pay. The
 * timesheet shows which hours fall into which band; what a store pays for them
 * is a decision it makes.
 */
export const OVERTIME_MULTIPLIER = 1.5
export const SUNDAY_MULTIPLIER = 2
/** Section 16(2): a Sunday for somebody who ordinarily works Sundays. */
export const SUNDAY_ORDINARY_MULTIPLIER = 1.5
/** Section 18(2)(a): a public holiday that is not an ordinary working day. */
export const HOLIDAY_MULTIPLIER = 2

/**
 * The multipliers actually in force, which a store may have agreed differently.
 *
 * The constants above are the BCEA figures and remain the defaults. A store
 * under a bargaining council agreement overrides them in settings — see the
 * `staff_*_multiplier` keys — and this is the shape those arrive in.
 */
export type PayMultipliers = {
  overtime: number
  /** Sunday, for somebody who does NOT ordinarily work Sundays. */
  sunday: number
  /** Sunday, for somebody who does. */
  sundayOrdinary: number
  holiday: number
}

export const BCEA_MULTIPLIERS: PayMultipliers = {
  overtime: OVERTIME_MULTIPLIER,
  sunday: SUNDAY_MULTIPLIER,
  sundayOrdinary: SUNDAY_ORDINARY_MULTIPLIER,
  holiday: HOLIDAY_MULTIPLIER,
}

/**
 * What one premium hour multiplies by.
 *
 * Premium hours are Sundays and public holidays together — `buildTimesheet`
 * bands them as one figure because both sit outside the ordinary week. They do
 * NOT always cost the same, though, so this is the one place that decides:
 *
 *   A public holiday is 18(2)(a), double, regardless of Sundays.
 *   A Sunday is 16(1) double, or 16(2) time-and-a-half for somebody who
 *   ordinarily works them.
 *
 * Kept here rather than in `staffCost.ts` so the timesheet screen can explain
 * the same rate the cost report charges.
 */
export function premiumMultiplier(
  kind: 'sunday' | 'holiday',
  worksSundays: boolean,
  rates: PayMultipliers = BCEA_MULTIPLIERS,
): number {
  if (kind === 'holiday') return rates.holiday
  return worksSundays ? rates.sundayOrdinary : rates.sunday
}

export type DayTotal = {
  /** YYYY-MM-DD, in local time. */
  date: string
  minutes: number
  entries: TimeEntry[]
  /** Any entry on this day still running. */
  hasOpen: boolean
  /** Any entry on this day amended by a manager. */
  hasEdit: boolean
  approved: boolean
  isSunday: boolean
  isPublicHoliday: boolean
}

export type PersonTimesheet = {
  userId: number
  userName: string
  days: DayTotal[]
  totalMinutes: number
  /** Up to the ordinary weekly hours, summed across the weeks in range. */
  ordinaryMinutes: number
  /** Everything above ordinary, excluding Sundays and holidays. */
  overtimeMinutes: number
  /** Sunday and public-holiday hours, which carry their own rate. */
  premiumMinutes: number
  /**
   * The two halves of `premiumMinutes`, which do not always cost the same.
   *
   * A public holiday is double under section 18(2)(a). A Sunday is double
   * under 16(1), or time-and-a-half under 16(2) for somebody who ordinarily
   * works Sundays — so the split has to survive banding for the cost report
   * to charge each correctly. A day that is both counts as a holiday, the
   * higher-certainty rate.
   */
  sundayMinutes: number
  holidayMinutes: number
  ordinaryHoursPw: number
  /** How many of the entries are still open — a timesheet cannot be approved
      while somebody is on the clock. */
  openCount: number
  approvedCount: number
  entryCount: number
}

/** YYYY-MM-DD in local time, so a shift belongs to the day it felt like. */
export function localDay(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Every date from `from` to `to`, inclusive, so empty days still appear. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(localDay(d))
  }
  return out
}

/**
 * Groups a person's entries into days and works out the bands.
 *
 * ── WHY OVERTIME IS PER WEEK, NOT PER DAY ───────────────────────────────
 *
 * BCEA section 9 caps ORDINARY hours at 45 a week. A nine-hour Tuesday is not
 * overtime if the week totals 40 — it is simply a long day inside a normal
 * week. Banding per day would invent overtime the law does not create and the
 * store does not owe.
 *
 * Weeks run Monday to Sunday, which is what `ordinary_hours_pw` describes.
 */
export function buildTimesheet(
  userId: number,
  userName: string,
  entries: TimeEntry[],
  from: string,
  to: string,
  ordinaryHoursPw: number,
  publicHolidays: ReadonlySet<string> = new Set(),
): PersonTimesheet {
  const byDay = new Map<string, TimeEntry[]>()
  for (const entry of entries) {
    const day = localDay(entry.startedAt)
    const list = byDay.get(day) ?? []
    list.push(entry)
    byDay.set(day, list)
  }

  const days: DayTotal[] = daysInRange(from, to).map((date) => {
    const dayEntries = byDay.get(date) ?? []
    const jsDay = new Date(`${date}T00:00:00`).getDay()
    return {
      date,
      minutes: dayEntries.reduce((sum, e) => sum + (e.minutes ?? 0), 0),
      entries: dayEntries,
      hasOpen: dayEntries.some((e) => e.endedAt === null),
      hasEdit: dayEntries.some((e) => e.editedReason !== null),
      // A day with no entries is not "approved"; it is empty.
      approved: dayEntries.length > 0 && dayEntries.every((e) => e.approvedAt !== null),
      isSunday: jsDay === 0,
      isPublicHoliday: publicHolidays.has(date),
    }
  })

  // Sunday and public-holiday minutes carry their own rate whatever the week
  // totals, so they come out before the weekly ordinary/overtime split.
  let sundayMinutes = 0
  let holidayMinutes = 0
  const weekly = new Map<string, number>()

  for (const day of days) {
    if (day.minutes === 0) continue
    if (day.isSunday || day.isPublicHoliday) {
      // A public holiday that falls on a Sunday counts once, as a holiday.
      // Section 18(2)(a) is the surer of the two rates: it does not depend on
      // whether this person ordinarily works Sundays.
      if (day.isPublicHoliday) holidayMinutes += day.minutes
      else sundayMinutes += day.minutes
      continue
    }
    const week = weekKey(day.date)
    weekly.set(week, (weekly.get(week) ?? 0) + day.minutes)
  }

  const ordinaryCap = ordinaryHoursPw * 60
  let ordinaryMinutes = 0
  let overtimeMinutes = 0

  for (const worked of weekly.values()) {
    ordinaryMinutes += Math.min(worked, ordinaryCap)
    overtimeMinutes += Math.max(0, worked - ordinaryCap)
  }

  const all = days.flatMap((d) => d.entries)

  return {
    userId,
    userName,
    days,
    totalMinutes: ordinaryMinutes + overtimeMinutes + sundayMinutes + holidayMinutes,
    ordinaryMinutes,
    overtimeMinutes,
    premiumMinutes: sundayMinutes + holidayMinutes,
    sundayMinutes,
    holidayMinutes,
    ordinaryHoursPw,
    openCount: all.filter((e) => e.endedAt === null).length,
    approvedCount: all.filter((e) => e.approvedAt !== null).length,
    entryCount: all.length,
  }
}

/** The Monday of the week a date falls in, as YYYY-MM-DD. */
export function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  // getDay() is 0 for Sunday, which belongs to the week that started six days
  // earlier rather than to the one beginning that morning.
  const offset = (d.getDay() + 6) % 7
  return localDay(new Date(d.getTime() - offset * 86_400_000))
}

/**
 * The hours a payroll system needs, banded.
 *
 * Decimal rather than minutes because that is what every payroll input expects,
 * and rounding once here beats each caller rounding differently.
 */
export function payrollHours(sheet: PersonTimesheet): {
  ordinary: number
  overtime: number
  premium: number
  sunday: number
  holiday: number
  total: number
} {
  return {
    ordinary: toHours(sheet.ordinaryMinutes),
    overtime: toHours(sheet.overtimeMinutes),
    premium: toHours(sheet.premiumMinutes),
    sunday: toHours(sheet.sundayMinutes),
    holiday: toHours(sheet.holidayMinutes),
    total: toHours(sheet.totalMinutes),
  }
}

/** Whether a sheet is in a state somebody can sign off. */
export function canApprove(sheet: PersonTimesheet): { ok: boolean; reason?: string } {
  if (sheet.entryCount === 0) return { ok: false, reason: 'There is nothing to approve.' }
  if (sheet.openCount > 0) {
    return {
      ok: false,
      reason:
        sheet.openCount === 1
          ? 'One shift is still open. Close it before approving.'
          : `${sheet.openCount} shifts are still open. Close them before approving.`,
    }
  }
  if (sheet.approvedCount === sheet.entryCount) {
    return { ok: false, reason: 'Already approved.' }
  }
  return { ok: true }
}

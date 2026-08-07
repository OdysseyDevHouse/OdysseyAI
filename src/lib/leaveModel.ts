/**
 * Leave facts shared by the server and the browser.
 *
 * Not `server-only`: the request form counts the working days somebody is
 * asking for while they pick dates, and the server counts them again on save.
 * The two must agree, so they share this. Same split as `employmentModel.ts`.
 */

export type AccrualMethod = 'none' | 'monthly' | 'annual_grant' | 'cycle_36m'
export type LeaveStatus = 'requested' | 'approved' | 'declined' | 'cancelled'
export type LedgerSource =
  | 'accrual'
  | 'taken'
  | 'adjustment'
  | 'opening'
  | 'forfeit'
  | 'payout'

export type LeaveType = {
  id: number
  name: string
  code: string
  isPaid: boolean
  accrualMethod: AccrualMethod
  accrualDays: number
  cycleMonths: number
  maxBalanceDays: number | null
  isSystem: boolean
  isActive: boolean
  notes: string | null
}

export type LeaveRequest = {
  id: number
  userId: number
  userName: string
  leaveTypeId: number
  leaveTypeName: string
  periodFrom: string
  periodTo: string
  days: number
  isHalfDay: boolean
  status: LeaveStatus
  reason: string | null
  decidedByName: string | null
  decidedAt: string | null
  decidedNote: string | null
}

export type LeaveBalance = {
  leaveTypeId: number
  leaveTypeName: string
  isPaid: boolean
  /** Everything accrued, adjusted or opened with. */
  accrued: number
  /** Everything taken, forfeited or paid out, as a positive number. */
  used: number
  /** accrued − used. Can be negative where a store allowed leave in advance. */
  balance: number
  /** Approved but not yet reached — already committed, not yet in the ledger. */
  pending: number
  /** balance − pending. What they could actually book today. */
  available: number
}

export const STATUS_LABELS: Record<LeaveStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

export const SOURCE_LABELS: Record<LedgerSource, string> = {
  accrual: 'Accrued',
  taken: 'Taken',
  adjustment: 'Adjustment',
  opening: 'Opening balance',
  forfeit: 'Forfeited',
  payout: 'Paid out',
}

export const ACCRUAL_LABELS: Record<AccrualMethod, string> = {
  none: 'No accrual',
  monthly: 'Each month',
  annual_grant: 'Once a year',
  cycle_36m: 'Per 36-month cycle',
}

/**
 * Working days in a range.
 *
 * Monday to Friday by default. `workingDays` lets a store on a six-day week
 * count Saturdays — a shop that trades Saturdays and does not count them would
 * quietly give everybody an extra day of leave for every week they take.
 *
 * Public holidays are excluded: BCEA section 20(3) says annual leave may not
 * run concurrently with a public holiday, so a week containing one costs four
 * days of leave rather than five.
 */
export function workingDaysBetween(
  from: string,
  to: string,
  workingDays: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]),
  publicHolidays: ReadonlySet<string> = new Set(),
): number {
  if (to < from) return 0

  let count = 0
  const end = new Date(`${to}T00:00:00`)
  for (let d = new Date(`${from}T00:00:00`); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const iso = localDay(d)
    if (!workingDays.has(d.getDay())) continue
    if (publicHolidays.has(iso)) continue
    count++
  }
  return count
}

/** YYYY-MM-DD in local time. */
export function localDay(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Months of service completed between two dates.
 *
 * Whole months only, and only those actually completed: somebody hired on the
 * 20th has not earned March's accrual on the 19th of April. Accruing a part
 * month would mean the balance moves every day, which is both wrong and
 * impossible to explain to the person holding it.
 */
export function monthsWorked(hiredOn: string, upTo: string): number {
  const start = new Date(`${hiredOn}T00:00:00`)
  const end = new Date(`${upTo}T00:00:00`)
  if (end < start) return 0

  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())
  // The anniversary day has to have passed for the month to count.
  if (end.getDate() < start.getDate()) months--
  return Math.max(0, months)
}

/**
 * What somebody should have accrued of a type by a given date.
 *
 * Returns the TOTAL entitlement to date, not an increment — the caller
 * compares it against what the ledger already holds and posts the difference.
 * That makes the accrual idempotent: running it twice, or late, or for a
 * back-dated hire, lands on the same number rather than adding twice.
 */
export function entitlementToDate(
  type: Pick<LeaveType, 'accrualMethod' | 'accrualDays' | 'cycleMonths'>,
  hiredOn: string,
  upTo: string,
): number {
  const months = monthsWorked(hiredOn, upTo)

  switch (type.accrualMethod) {
    case 'monthly':
      return round2(months * type.accrualDays)

    case 'annual_grant': {
      // The whole year's allowance on each anniversary, including the first
      // day of employment — s27 family leave is available from four months,
      // which a store enforces by policy rather than by withholding accrual.
      const years = Math.floor(months / 12) + 1
      return round2(years * type.accrualDays)
    }

    case 'cycle_36m': {
      // BCEA s22: 30 days per 36-month cycle, available in full from the start
      // of the cycle rather than accrued through it.
      //
      // DELIBERATELY NOT CUMULATIVE. The entitlement is per cycle and the
      // previous cycle's balance lapses — somebody employed nine years has 30
      // days available, not 90. Multiplying by the number of cycles would hand
      // a long-serving employee three months of paid sick leave the Act does
      // not give them, and a store would only discover it when somebody took
      // it.
      //
      // So this returns one block, and the caller tops up to it. The ledger
      // then shows a fresh grant at each cycle boundary rather than one number
      // growing forever.
      //
      // Section 23 restricts the FIRST six months to one day per 26 worked.
      // That is a policy a store applies when approving, not a change to the
      // entitlement — enforcing it here would refuse leave the employer may
      // choose to allow.
      return round2(type.accrualDays)
    }

    case 'none':
    default:
      return 0
  }
}

/** Half-cent-safe rounding to two places, matching the DECIMAL(6,2) columns. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** "3 days" / "1 day" / "half a day". */
export function formatDays(days: number): string {
  if (days === 0.5) return 'half a day'
  if (days === 1) return '1 day'
  return `${round2(days)} days`
}

/**
 * Whether a request can be made, given what is left.
 *
 * Unpaid types are never refused on balance — that is the whole point of
 * unpaid leave, and blocking it would leave somebody with nothing to book when
 * their paid leave runs out.
 */
export function checkRequest(
  type: Pick<LeaveType, 'isPaid' | 'name'>,
  days: number,
  available: number,
  allowNegative: boolean,
): string | null {
  if (days <= 0) return 'That range contains no working days.'
  if (!type.isPaid) return null
  if (allowNegative) return null

  if (days > available) {
    return available <= 0
      ? `There is no ${type.name.toLowerCase()} left. Take it as unpaid, or ask for an adjustment.`
      : `Only ${formatDays(available)} of ${type.name.toLowerCase()} left, and this asks for ${formatDays(days)}.`
  }
  return null
}

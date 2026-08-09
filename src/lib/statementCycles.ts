/**
 * Statement cycles — how an account's history is cut into periods.
 *
 * A statement is not a date range someone typed; it is "August 2026", or "the
 * week of the 3rd". That period has to be reproducible: the same account asked
 * the same question next year must yield the same two dates, or a reprint
 * disagrees with what was posted. So periods are DERIVED from a cycle and an
 * anchor, never stored per statement.
 *
 * PURE on purpose — no database, no siteId, and deliberately not importing from
 * site/ledger.ts, which is server-only. The customer form calls periodContaining
 * in the browser to preview the next period as you change the anchor, and that
 * is only possible if this module runs on both sides.
 *
 * Cycle is INDEPENDENT of payment terms. Terms decide when an invoice is due;
 * the cycle decides when the account is cut. A 30-day-terms account can be
 * statemented weekly, and conflating the two is the confusion this module is
 * named to avoid.
 */

export const STATEMENT_CYCLES = ['monthly', '14day', '7day'] as const
export type StatementCycle = (typeof STATEMENT_CYCLES)[number]

/**
 * The bucket keys, restated rather than imported.
 *
 * `AgingBucket` lives in site/ledger.ts, which is server-only, and this module
 * has to run in the browser. The same duplication the payables table makes for
 * the same reason — see AgeAnalysisTable.tsx. The keys are fixed by the Aging
 * type and change only if that changes.
 */
type Bucket = 'current' | 'd30' | 'd60' | 'd90' | 'd120'

export const CYCLE_LABELS: Record<StatementCycle, string> = {
  monthly: 'Monthly',
  '14day': 'Every 14 days',
  '7day': 'Weekly (7 days)',
}

/**
 * Days one period spans, used as the aging bucket width.
 *
 * Monthly is the nominal 30 — a calendar month varies, but the bucket ladder
 * cannot, and 30/60/90/120 is the ladder every bank and auditor reads.
 */
export const CYCLE_DAYS: Record<StatementCycle, number> = {
  monthly: 30,
  '14day': 14,
  '7day': 7,
}

export type StatementPeriod = {
  /** yyyy-mm-dd, inclusive. */
  from: string
  /** yyyy-mm-dd, inclusive. */
  to: string
  /** 'August 2026' | '25 Jul – 24 Aug 2026' | '3–9 Aug 2026' */
  label: string
  /** Stable URL value, `${from}:${to}` — the composite vatReturn.ts uses. */
  key: string
  /** True when the period contains the date the list was generated for. */
  isCurrent: boolean
}

export type CycleConfig = {
  cycle: StatementCycle
  /** Monthly only. 1–31, or 0 for the calendar month. */
  anchorDay?: number
  /** 7/14-day only. The phase; null falls back to fallbackAnchor. */
  anchorDate?: string | null
  /** Used when anchorDate is null — pass the account's creation date. */
  fallbackAnchor?: string
}

/** Narrows an untrusted string, for reading a form field or a URL param. */
export function toStatementCycle(value: unknown): StatementCycle {
  const raw = String(value ?? '')
  return (STATEMENT_CYCLES as readonly string[]).includes(raw)
    ? (raw as StatementCycle)
    : 'monthly'
}

/* ── Dates ───────────────────────────────────────────────────────────────── */
//
// Local-time arithmetic via setDate, never `time + n * 86_400_000`. Adding
// milliseconds shifts by a day across a DST boundary; setDate does not. South
// Africa has no DST, but the code must not quietly depend on that.

const ISO = /^\d{4}-\d{2}-\d{2}$/

function parse(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function addDays(date: string, days: number): string {
  const d = parse(date)
  d.setDate(d.getDate() + days)
  return iso(d)
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
function daysApart(from: string, to: string): number {
  const a = parse(from).getTime()
  const b = parse(to).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** Days in a month. `month` is 1-based. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/* ── Period boundaries ───────────────────────────────────────────────────── */

/**
 * The anchor day for a given month, clamped to the month's length.
 *
 * The 31st of February is the 28th (or 29th). Clamping rather than rolling
 * into March keeps consecutive periods contiguous — see the migration comment
 * in 065_statement_cycles.sql on why that property is load-bearing.
 */
function anchorInMonth(year: number, month: number, anchorDay: number): string {
  const day = Math.min(Math.max(anchorDay, 1), daysInMonth(year, month))
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Steps a 1-based year/month pair by `delta` months. */
function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta
  return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 }
}

function monthlyPeriod(date: string, anchorDay: number): { from: string; to: string } {
  const d = parse(date)
  const year = d.getFullYear()
  const month = d.getMonth() + 1

  // Calendar month — the default, and what every account did before cycles.
  if (anchorDay <= 0) {
    return {
      from: `${year}-${String(month).padStart(2, '0')}-01`,
      to: `${year}-${String(month).padStart(2, '0')}-${daysInMonth(year, month)}`,
    }
  }

  // Anchored: the period starts on the anchor and ends the day before the next
  // one. Each month's anchor is computed independently so clamping in a short
  // month cannot drift the following period.
  const thisMonth = anchorInMonth(year, month, anchorDay)
  const start = date >= thisMonth ? { year, month } : shiftMonth(year, month, -1)
  const next = shiftMonth(start.year, start.month, 1)

  const from = anchorInMonth(start.year, start.month, anchorDay)
  return { from, to: addDays(anchorInMonth(next.year, next.month, anchorDay), -1) }
}

function rollingPeriod(date: string, anchor: string, span: number): { from: string; to: string } {
  // Math.floor, not truncation: a date BEFORE the anchor gives a negative
  // quotient and must still land in a well-formed period. An opening balance
  // dated before the account was created is exactly that case.
  const n = Math.floor(daysApart(anchor, date) / span)
  const from = addDays(anchor, n * span)
  return { from, to: addDays(from, span - 1) }
}

function resolveAnchor(config: CycleConfig): string {
  const explicit = config.anchorDate
  if (explicit && ISO.test(explicit)) return explicit
  const fallback = config.fallbackAnchor
  if (fallback && ISO.test(fallback)) return fallback
  // Neither given. A fixed epoch keeps periods deterministic rather than
  // rebasing on today, which would move every historic period overnight.
  return '2000-01-03'
}

/* ── Labels ──────────────────────────────────────────────────────────────── */

function labelFor(cycle: StatementCycle, from: string, to: string, anchorDay: number): string {
  const a = parse(from)
  const b = parse(to)

  if (cycle === 'monthly' && anchorDay <= 0) {
    return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`
  }

  const sameYear = a.getFullYear() === b.getFullYear()
  const sameMonth = sameYear && a.getMonth() === b.getMonth()

  // '3–9 Aug 2026' — one month, so name it once.
  if (sameMonth) {
    return `${a.getDate()}–${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`
  }
  // '28 Jul – 3 Aug 2026'
  if (sameYear) {
    return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`
  }
  // '29 Dec 2025 – 4 Jan 2026'
  return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`
}

/* ── The API ─────────────────────────────────────────────────────────────── */

/** The period containing `date`. The building block; never returns null. */
export function periodContaining(config: CycleConfig, date: string): StatementPeriod {
  const on = ISO.test(date) ? date : todayLocal()
  const anchorDay = config.anchorDay ?? 0

  const { from, to } =
    config.cycle === 'monthly'
      ? monthlyPeriod(on, anchorDay)
      : rollingPeriod(on, resolveAnchor(config), CYCLE_DAYS[config.cycle])

  return {
    from,
    to,
    label: labelFor(config.cycle, from, to, anchorDay),
    key: `${from}:${to}`,
    isCurrent: from <= on && to >= on,
  }
}

/** The period immediately before the one given. */
function previousPeriod(config: CycleConfig, period: StatementPeriod): StatementPeriod {
  return periodContaining(config, addDays(period.from, -1))
}

/**
 * The current period and the `count - 1` before it, newest first.
 *
 * Thirteen by default: monthly reaches the same month last year, weekly reaches
 * a quarter back, and thirteen options is still a list you can scan. Older than
 * that is what the custom range is for.
 */
export function statementPeriods(
  config: CycleConfig,
  asAt: string,
  count = 13,
): StatementPeriod[] {
  const periods: StatementPeriod[] = []
  let period = periodContaining(config, asAt)

  for (let i = 0; i < Math.max(count, 1); i++) {
    periods.push({ ...period, isCurrent: i === 0 })
    period = previousPeriod(config, period)
  }

  return periods
}

/**
 * The period a `from:to` key names, or null.
 *
 * Resolved through periodContaining rather than trusted as given, so a
 * hand-edited URL cannot produce a statement over an arbitrary window that
 * claims to be a cycle period. A key whose dates are not a real boundary of
 * this account's cycle is rejected.
 */
export function periodFromKey(
  config: CycleConfig,
  key: string | undefined,
  asAt: string,
): StatementPeriod | null {
  if (!key) return null
  const [from, to] = key.split(':')
  if (!ISO.test(from ?? '') || !ISO.test(to ?? '')) return null

  const period = periodContaining(config, from)
  if (period.from !== from || period.to !== to) return null

  return { ...period, isCurrent: period.from <= asAt && period.to >= asAt }
}

/**
 * Aging bucket labels widened to the cycle.
 *
 * Four overdue buckets at every width, open-ended at the top, so the Aging
 * shape never changes — only what the columns are called. A weekly account
 * reads 7/14/21/28+, a monthly one the familiar 30/60/90/120+.
 *
 * Statement-only. The book-wide age analysis keeps fixed 30-day buckets: it
 * compares many accounts in one table, and columns that mean different things
 * per row cannot be totalled or sorted.
 */
export function cycleBucketLabels(cycle: StatementCycle): Record<Bucket, string> {
  const step = CYCLE_DAYS[cycle]
  return {
    current: 'Current',
    d30: `${step} days`,
    d60: `${step * 2} days`,
    d90: `${step * 3} days`,
    d120: `${step * 4}+ days`,
  }
}

/** Local today. Duplicated from ledger.ts, which is server-only. */
function todayLocal(): string {
  return iso(new Date())
}

/**
 * South African public holidays.
 *
 * Not `server-only`. A settings screen wants to show a store which days it is
 * about to pay at holiday rates, and the timesheet server needs the same set —
 * the two disagreeing about whether the 21st of March is a holiday would be
 * worse than either being wrong. Same split as `timesheetModel.ts`.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * `site/timesheets.ts` computed the ten fixed-date holidays inline and left a
 * note explaining the two that were missing:
 *
 *   "The moving ones — Good Friday and Family Day — are NOT here. They follow
 *    the ecclesiastical calendar, and a wrong Easter is worse than an absent
 *    one because it silently mis-bands somebody's pay."
 *
 * The caution was right and the conclusion was too cautious. Easter is not
 * approximated — it is DEFINED by an algorithm, and that algorithm is exact.
 * Absent, those two days band as ordinary hours, so anybody working the Easter
 * weekend is underpaid every year. A computed Easter is not a guess; it is the
 * same arithmetic the calendar itself is printed from.
 */

/** A public holiday on a particular date. */
export type Holiday = {
  /** YYYY-MM-DD. */
  date: string
  name: string
  /**
   * True when this day is only a holiday because the actual one fell on a
   * Sunday — Public Holidays Act section 2(1). Worth distinguishing so a
   * screen can explain why a Monday in April is being paid at holiday rates.
   */
  observed: boolean
}

/** The ten holidays that fall on the same date every year. */
const FIXED: { month: number; day: number; name: string }[] = [
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 3, day: 21, name: 'Human Rights Day' },
  { month: 4, day: 27, name: 'Freedom Day' },
  { month: 5, day: 1, name: "Workers' Day" },
  { month: 6, day: 16, name: 'Youth Day' },
  { month: 8, day: 9, name: "National Women's Day" },
  { month: 9, day: 24, name: 'Heritage Day' },
  { month: 12, day: 16, name: 'Day of Reconciliation' },
  { month: 12, day: 25, name: 'Christmas Day' },
  { month: 12, day: 26, name: 'Day of Goodwill' },
]

/**
 * Easter Sunday, by the anonymous Gregorian Computus.
 *
 * This is the Meeus/Jones/Butcher algorithm. It is not an approximation and
 * has no error term: it reproduces the ecclesiastical rule exactly for every
 * year in the Gregorian calendar, which is what the Public Holidays Act
 * schedules Good Friday against.
 *
 * The intermediate names are the conventional ones from the algorithm rather
 * than anything descriptive — renaming them to `a`, `b`, `c` would be no
 * clearer, and renaming them to invented words would make the algorithm
 * impossible to check against any published statement of it. Verified against
 * known Easters in `scripts/test-holidays.ts`.
 */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

/** YYYY-MM-DD from parts, with no timezone in the way. */
function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Days added to a YYYY-MM-DD, as YYYY-MM-DD. Local noon, so DST cannot shift the date. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** 0 = Sunday, matching Date#getDay. Noon again, for the same reason. */
function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00`).getDay()
}

/**
 * Every statutory holiday in a calendar year.
 *
 * Includes the Monday observances required by section 2(1) — when a holiday
 * falls on a Sunday, the following Monday is a public holiday too.
 *
 * Good Friday is Easter Sunday less two days; Family Day (Easter Monday) is
 * Easter Sunday plus one. Neither can fall on a Sunday by construction, so
 * neither needs the observance rule.
 *
 * ── WHY THE OBSERVANCE CASCADES ─────────────────────────────────────────
 *
 * Christmas on a Sunday is the awkward case, and it comes round about three
 * times a decade — 2022, 2033, 2039. Section 2(1) moves the observance to the
 * Monday, but the Monday IS the 26th, which is already the Day of Goodwill.
 *
 * Two holidays cannot occupy one date: the store owes ONE extra paid day, not
 * two on the same day. So the displaced day walks forward to the first date
 * that is still free — Christmas is observed on the 26th and Goodwill moves to
 * the 27th, which is what every published South African calendar shows for
 * those years. Without this the same date appeared twice, and the day the
 * store actually owed went missing entirely.
 */
export function holidaysInYear(year: number): Holiday[] {
  const out: Holiday[] = []
  const taken = new Set<string>()

  const add = (date: string, name: string, observed: boolean) => {
    out.push({ date, name, observed })
    taken.add(date)
  }

  for (const { month, day, name } of FIXED) {
    add(iso(year, month, day), name, false)
  }

  const easter = easterSunday(year)
  const easterDate = iso(year, easter.month, easter.day)
  add(addDays(easterDate, -2), 'Good Friday', false)
  add(addDays(easterDate, 1), 'Family Day', false)

  // Observances come SECOND, once every actual holiday is on the board — so a
  // displaced day knows which dates are genuinely free. Ordering matters here:
  // interleaving them would let Christmas's observance claim the 26th before
  // the Day of Goodwill had claimed it.
  for (const { month, day, name } of FIXED) {
    const date = iso(year, month, day)
    if (dayOfWeek(date) !== 0) continue

    let observedOn = addDays(date, 1)
    while (taken.has(observedOn)) observedOn = addDays(observedOn, 1)
    add(observedOn, `${name} (observed)`, true)
  }

  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Every statutory holiday between two dates, inclusive.
 *
 * Spans the years the range touches rather than assuming one, so a December
 * to January timesheet gets both Christmas and New Year's Day.
 */
export function statutoryHolidays(from: string, to: string): Holiday[] {
  const startYear = Number(from.slice(0, 4))
  const endYear = Number(to.slice(0, 4))

  const out: Holiday[] = []
  for (let year = startYear; year <= endYear; year++) {
    for (const holiday of holidaysInYear(year)) {
      if (holiday.date >= from && holiday.date <= to) out.push(holiday)
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The statutory calendar with a store's own additions and removals applied.
 *
 * Overrides win, in both directions: a row marked `isWorkingDay` removes a
 * computed holiday, and any other row adds one. A store that does not observe
 * a day, or that gazettes an election day, can say so — see `public_holidays`
 * in migration 063.
 */
export function effectiveHolidays(
  from: string,
  to: string,
  overrides: readonly { date: string; name: string; isWorkingDay: boolean }[] = [],
): Holiday[] {
  const byDate = new Map<string, Holiday>()
  for (const holiday of statutoryHolidays(from, to)) byDate.set(holiday.date, holiday)

  for (const override of overrides) {
    if (override.date < from || override.date > to) continue
    if (override.isWorkingDay) byDate.delete(override.date)
    else byDate.set(override.date, { date: override.date, name: override.name, observed: false })
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** Just the dates, which is what the timesheet bands against. */
export function holidayDates(holidays: readonly Holiday[]): ReadonlySet<string> {
  return new Set(holidays.map((h) => h.date))
}

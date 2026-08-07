/**
 * Public holidays — Easter, the fixed days, observances and overrides.
 *
 *   npm run test:holidays
 *
 * The property that matters most:
 *
 *   EASTER IS EXACT, NOT APPROXIMATE. `site/timesheets.ts` left Good Friday
 *   and Family Day out because "a wrong Easter is worse than an absent one".
 *   That caution is only answered by checking the algorithm against dates
 *   somebody can look up — which is what the first block below does. Absent,
 *   those two days band as ordinary hours and underpay anybody who works them.
 *
 * Pure arithmetic, so this needs no database and no site.
 */
import {
  easterSunday,
  holidaysInYear,
  statutoryHolidays,
  effectiveHolidays,
  holidayDates,
} from '../src/lib/holidayModel'

let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} — got ${actual}, expected ${expected}`)
  if (!ok) failures++
}

console.log('\n── Easter, against dates anybody can check ─────────────────────')

// Published Easter Sundays. Deliberately spanning a wide range, including the
// 2038 case that catches a 32-bit date overflow, and 2024's 31 March, which is
// the earliest Easter in this set and the one an off-by-one shows up in.
const KNOWN_EASTERS: Record<number, string> = {
  2018: '2018-04-01',
  2019: '2019-04-21',
  2020: '2020-04-12',
  2021: '2021-04-04',
  2022: '2022-04-17',
  2023: '2023-04-09',
  2024: '2024-03-31',
  2025: '2025-04-20',
  2026: '2026-04-05',
  2027: '2027-03-28',
  2028: '2028-04-16',
  2030: '2030-04-21',
  2038: '2038-04-25',
}

for (const [year, expected] of Object.entries(KNOWN_EASTERS)) {
  const { month, day } = easterSunday(Number(year))
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  eq(`Easter ${year}`, iso, expected)
}

console.log('\n── Good Friday and Family Day hang off it ─────────────────────')

// The two days that were missing entirely. 2026: Easter is 5 April, so Good
// Friday is the 3rd and Family Day the 6th.
const y2026 = holidaysInYear(2026)
const goodFriday = y2026.find((h) => h.name === 'Good Friday')
const familyDay = y2026.find((h) => h.name === 'Family Day')

eq('Good Friday 2026 is Easter less two days', goodFriday?.date, '2026-04-03')
eq('Family Day 2026 is Easter plus one', familyDay?.date, '2026-04-06')

// Across a year where Easter falls in March, to be sure the month rolls back.
const y2024 = holidaysInYear(2024)
eq(
  'Good Friday 2024 crosses back into March',
  y2024.find((h) => h.name === 'Good Friday')?.date,
  '2024-03-29',
)
eq(
  'Family Day 2024 is the 1st of April',
  y2024.find((h) => h.name === 'Family Day')?.date,
  '2024-04-01',
)

console.log('\n── The fixed days, and the Sunday observance ──────────────────')

const dates2026 = holidayDates(holidaysInYear(2026))
check('New Year is a holiday', dates2026.has('2026-01-01'))
check('Human Rights Day is a holiday', dates2026.has('2026-03-21'))
check('Christmas is a holiday', dates2026.has('2026-12-25'))
check('Day of Goodwill is a holiday', dates2026.has('2026-12-26'))

// Public Holidays Act s2(1): a holiday on a Sunday moves the observance to
// the Monday. 2027-12-26 (Day of Goodwill) is a Sunday, so the 27th is one too.
const y2027 = holidayDates(holidaysInYear(2027))
check('a Sunday holiday is still a holiday', y2027.has('2027-12-26'))
check('and the Monday after is observed', y2027.has('2027-12-27'))

const observed = holidaysInYear(2027).find((h) => h.date === '2027-12-27')
check('the observed day says so', observed?.observed === true, observed?.name)

// A weekday holiday must NOT create an observance — that would invent a paid
// day the store does not owe.
check(
  'a weekday holiday creates no observance',
  !holidaysInYear(2026).some((h) => h.date === '2026-12-26' && h.observed),
)

console.log('\n── Christmas on a Sunday displaces the Day of Goodwill ────────')

// The awkward case, roughly three times a decade. 25 December 2022 is a
// Sunday, so its observance is the 26th — which is already the Day of
// Goodwill. The store owes ONE extra day, not two on one date, so Goodwill
// walks to the 27th. Every published SA calendar for 2022 shows exactly this.
const xmas2022 = holidaysInYear(2022)
const dates2022 = holidayDates(xmas2022)

check('Christmas Day itself', dates2022.has('2022-12-25'))
check('the 26th is a holiday', dates2022.has('2022-12-26'))
check('and the displaced day lands on the 27th', dates2022.has('2022-12-27'))

eq(
  'no date is claimed twice',
  new Set(xmas2022.map((h) => h.date)).size,
  xmas2022.length,
)
// The Day of Goodwill KEEPS the 26th — it is a holiday in its own right on a
// Monday, not an observance. It is Christmas whose observance is pushed on to
// the 27th, which is how the 2022 calendar was actually gazetted.
eq('the Day of Goodwill keeps the 26th', xmas2022.find((h) => h.date === '2022-12-26')?.name, 'Day of Goodwill')
eq(
  "and Christmas's observance is what moved",
  xmas2022.find((h) => h.name === 'Christmas Day (observed)')?.date,
  '2022-12-27',
)

// 2033 and 2039 are the same shape, and worth pinning so a future change to
// the cascade cannot quietly regress only the rarer years.
for (const year of [2033, 2039]) {
  const all = holidaysInYear(year)
  eq(`${year} claims no date twice`, new Set(all.map((h) => h.date)).size, all.length)
  check(`${year} still observes three days over Christmas`, holidayDates(all).has(`${year}-12-27`))
}

console.log('\n── Ranges span the years they touch ───────────────────────────')

// A December-to-January timesheet needs both Christmas and New Year's Day.
const straddle = holidayDates(statutoryHolidays('2026-12-20', '2027-01-05'))
check('Christmas is in a straddling range', straddle.has('2026-12-25'))
check("and so is the next year's New Year", straddle.has('2027-01-01'))
check('but not a day outside it', !straddle.has('2026-12-16'))

const march = statutoryHolidays('2026-03-01', '2026-03-31')
eq('a single month returns only its own', march.length, 1)
eq('which is Human Rights Day', march[0]?.date, '2026-03-21')

console.log('\n── A store overrides both ways ────────────────────────────────')

// Adding a day the calendar cannot know about — a gazetted election day.
const withElection = holidayDates(
  effectiveHolidays('2026-05-01', '2026-05-31', [
    { date: '2026-05-20', name: 'Election Day', isWorkingDay: false },
  ]),
)
check("Workers' Day is still there", withElection.has('2026-05-01'))
check('and the declared day is added', withElection.has('2026-05-20'))

// Removing one the store does not observe. This is the direction that costs
// money if it silently fails — the store would pay premium rates all day.
const without = holidayDates(
  effectiveHolidays('2026-05-01', '2026-05-31', [
    { date: '2026-05-01', name: 'We trade', isWorkingDay: true },
  ]),
)
check('a day marked as working is not a holiday', !without.has('2026-05-01'))

// An override outside the range must not leak in.
const ranged = holidayDates(
  effectiveHolidays('2026-05-01', '2026-05-31', [
    { date: '2026-07-04', name: 'Not ours', isWorkingDay: false },
  ]),
)
check('an override outside the range is ignored', !ranged.has('2026-07-04'))

console.log('\n── Every year is sane ─────────────────────────────────────────')

// A loop over a long span, checking nothing degenerates: no duplicate dates,
// and the count never falls below the twelve statutory days.
for (let year = 2020; year <= 2040; year++) {
  const all = holidaysInYear(year)
  const unique = new Set(all.map((h) => h.date))
  if (unique.size !== all.length) {
    check(`${year} has no duplicate dates`, false, `${all.length} rows, ${unique.size} dates`)
  }
  if (all.length < 12) {
    check(`${year} has at least the twelve statutory days`, false, `${all.length}`)
  }
}
check('2020-2040 all produce distinct, complete calendars', true)

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)

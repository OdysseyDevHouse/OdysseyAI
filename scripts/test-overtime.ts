/**
 * Overtime: the Sunday flag, the holiday split, and configurable multipliers.
 *
 *   npm run test:overtime
 *
 * What 063 added on top of the banding that already worked. Three properties:
 *
 *   A SUNDAY IS NOT ALWAYS DOUBLE. BCEA s16(1) pays double, but s16(2) pays
 *   one and a half to somebody who ORDINARILY works Sundays. Before the flag,
 *   every store trading on a Sunday over-stated its wage bill.
 *
 *   A HOLIDAY AND A SUNDAY ARE ONE BAND BUT NOT ONE RATE. The timesheet totals
 *   them together as premium hours; the cost report has to charge s18(2)(a)
 *   for one and s16 for the other, so the split must survive banding.
 *
 *   THE MULTIPLIERS ARE THE STORE'S. The BCEA figures are defaults, not
 *   constants — a bargaining council agreement can set higher.
 */
import { siteExecute } from '../src/lib/siteDb'
import { costReport } from '../src/lib/site/staffCost'
import { setSetting, validateSetting } from '../src/lib/site/settings'
import { buildTimesheet, premiumMultiplier, BCEA_MULTIPLIERS } from '../src/lib/timesheetModel'
import type { TimeEntry } from '../src/lib/timeModel'

const SITE = 1
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

/** An entry for a given local day, `hours` long. */
function entry(day: string, hours: number): TimeEntry {
  const started = new Date(`${day}T08:00:00`)
  return {
    id: Math.floor(Math.random() * 1e9),
    userId: 1,
    userName: 'Test',
    startedAt: started.toISOString(),
    endedAt: new Date(started.getTime() + hours * 3600_000).toISOString(),
    source: 'manual',
    terminalId: null,
    shiftId: null,
    breakMinutes: 0,
    note: null,
    editedByName: null,
    editedReason: null,
    approvedAt: null,
    minutes: hours * 60,
  }
}

let sundayWorkerId = 0
let weekdayWorkerId = 0

async function main() {
  /* ── Banding keeps the two kinds of premium apart ──────────────────── */
  console.log('\nthe premium split')

  // 2019-03-10 is a Sunday. 2019-03-21 is Human Rights Day, a Thursday.
  const sheet = buildTimesheet(
    1,
    'Test',
    [entry('2019-03-10', 4), entry('2019-03-21', 6)],
    '2019-03-04',
    '2019-03-24',
    45,
    new Set(['2019-03-21']),
  )

  eq('Sunday hours are counted apart', sheet.sundayMinutes, 240)
  eq('holiday hours are counted apart', sheet.holidayMinutes, 360)
  eq('and premium is still their sum', sheet.premiumMinutes, 600)
  eq('neither leaks into overtime', sheet.overtimeMinutes, 0)
  eq('nor into ordinary', sheet.ordinaryMinutes, 0)

  // A public holiday that falls on a Sunday must count ONCE, as a holiday —
  // otherwise the same hours are paid twice.
  const both = buildTimesheet(
    1,
    'Test',
    [entry('2019-03-10', 5)],
    '2019-03-04',
    '2019-03-17',
    45,
    new Set(['2019-03-10']),
  )
  eq('a holiday on a Sunday counts once', both.premiumMinutes, 300)
  eq('and counts as the holiday', both.holidayMinutes, 300)
  eq('not as a Sunday too', both.sundayMinutes, 0)

  /* ── Which multiplier applies ──────────────────────────────────────── */
  console.log('\nthe rate for a premium hour')

  eq('a Sunday, for somebody who does not work them', premiumMultiplier('sunday', false), 2)
  eq('a Sunday, for somebody who does — s16(2)', premiumMultiplier('sunday', true), 1.5)
  eq('a holiday is double regardless', premiumMultiplier('holiday', false), 2)
  eq('even for a Sunday worker', premiumMultiplier('holiday', true), 2)

  // A store's own agreement overrides all four.
  const agreed = { overtime: 2, sunday: 3, sundayOrdinary: 2, holiday: 2.5 }
  eq('an agreed Sunday rate is used', premiumMultiplier('sunday', false, agreed), 3)
  eq('an agreed holiday rate is used', premiumMultiplier('holiday', false, agreed), 2.5)

  /* ── End to end, against the database ──────────────────────────────── */
  console.log('\nwhat a Sunday actually costs')

  const a = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('OT Sunday Worker','pos_only',1)`,
  )
  sundayWorkerId = a.insertId

  const b = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('OT Weekday Worker','pos_only',1)`,
  )
  weekdayWorkerId = b.insertId

  // Same rate, same hours, same Sunday. The ONLY difference is the flag.
  await siteExecute(
    SITE,
    `INSERT INTO user_employment
       (user_id, pay_basis, hourly_rate, ordinary_hours_pw, works_sundays, hired_on)
     VALUES (?, 'hourly', 100, 45, 1, '2018-01-01')`,
    [sundayWorkerId],
  )
  await siteExecute(
    SITE,
    `INSERT INTO user_employment
       (user_id, pay_basis, hourly_rate, ordinary_hours_pw, works_sundays, hired_on)
     VALUES (?, 'hourly', 100, 45, 0, '2018-01-01')`,
    [weekdayWorkerId],
  )

  for (const id of [sundayWorkerId, weekdayWorkerId]) {
    await siteExecute(
      SITE,
      `INSERT INTO staff_time_entries (user_id, user_name, started_at, ended_at, source)
       VALUES (?, 'OT Test', '2019-03-10 09:00:00', '2019-03-10 13:00:00', 'manual')`,
      [id],
    )
  }

  const report = await costReport(SITE, '2019-03-04', '2019-03-17', true)
  const sundayLine = report.lines.find((l) => l.userId === sundayWorkerId)!
  const weekdayLine = report.lines.find((l) => l.userId === weekdayWorkerId)!

  eq('both worked four premium hours', sundayLine.premiumHours, 4)
  eq('and so did the other', weekdayLine.premiumHours, 4)

  // 4 × 100 × 2 = 800 — s16(1), the rate before this change, unchanged.
  eq('somebody who does not work Sundays is paid double', weekdayLine.premiumCost, 800)
  // 4 × 100 × 1.5 = 600 — s16(2). This is the figure that was wrong.
  eq('somebody who ordinarily does is paid one and a half', sundayLine.premiumCost, 600)

  /* ── A store's own multipliers ─────────────────────────────────────── */
  console.log('\nconfigurable multipliers')

  check(
    'a multiplier below 1 is refused',
    validateSetting('staff_sunday_multiplier', '0.5') !== null,
    validateSetting('staff_sunday_multiplier', '0.5') ?? '',
  )
  check(
    'and one above 5 is refused',
    validateSetting('staff_overtime_multiplier', '15') !== null,
  )
  check('a plausible one is accepted', validateSetting('staff_overtime_multiplier', '1.75') === null)
  check('so is the BCEA default', validateSetting('staff_sunday_multiplier', '2') === null)

  // Raise the Sunday rate the way a bargaining council agreement would, and
  // confirm the report follows it rather than the constant.
  await setSetting(SITE, 'staff_sunday_multiplier', '3')
  const raised = await costReport(SITE, '2019-03-04', '2019-03-17', true)
  const raisedLine = raised.lines.find((l) => l.userId === weekdayWorkerId)!
  // 4 × 100 × 3 = 1200
  eq('an agreed Sunday rate reaches the cost report', raisedLine.premiumCost, 1200)

  // The Sunday worker is on a different key, so they must NOT have moved.
  const raisedSunday = raised.lines.find((l) => l.userId === sundayWorkerId)!
  eq('and does not disturb the s16(2) rate', raisedSunday.premiumCost, 600)

  await setSetting(SITE, 'staff_sunday_multiplier', '2')
  const restored = await costReport(SITE, '2019-03-04', '2019-03-17', true)
  eq(
    'putting it back restores the statutory figure',
    restored.lines.find((l) => l.userId === weekdayWorkerId)!.premiumCost,
    800,
  )

  /* ── The defaults are the BCEA figures ─────────────────────────────── */
  console.log('\nthe defaults')
  eq('overtime defaults to one and a half', BCEA_MULTIPLIERS.overtime, 1.5)
  eq('a Sunday to double', BCEA_MULTIPLIERS.sunday, 2)
  eq('a Sunday for somebody who works them, to one and a half', BCEA_MULTIPLIERS.sundayOrdinary, 1.5)
  eq('a holiday to double', BCEA_MULTIPLIERS.holiday, 2)
}

async function cleanup() {
  console.log('\ncleaning up...')
  // Leave the setting as the BCEA default whatever happened above, so a failed
  // run cannot leave this site costing Sundays at triple.
  await setSetting(SITE, 'staff_sunday_multiplier', '2').catch(() => {})
  for (const id of [sundayWorkerId, weekdayWorkerId].filter(Boolean)) {
    await siteExecute(SITE, 'DELETE FROM staff_time_entries WHERE user_id = ?', [id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [id]).catch(() => {})
  }
  console.log('removed the test users')
}

main()
  .then(async () => {
    await cleanup()
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
    process.exit(failures ? 1 : 0)
  })
  .catch(async (error) => {
    await cleanup()
    console.error('\n', error)
    process.exit(1)
  })

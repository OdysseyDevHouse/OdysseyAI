/**
 * Timesheets — banding, weeks, approval.
 *
 *   npm run test:timesheets
 *
 * The property that matters most:
 *
 *   OVERTIME IS PER WEEK, NOT PER DAY. BCEA s9 caps ORDINARY hours at 45 a
 *   week. A nine-hour Tuesday inside a 40-hour week is a long day, not
 *   overtime — banding per day would invent hours the store does not owe and
 *   the law does not create.
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { timesheetsFor, approveRange, unapproveRange } from '../src/lib/site/timesheets'
import {
  buildTimesheet,
  weekKey,
  daysInRange,
  payrollHours,
  canApprove,
  localDay,
} from '../src/lib/timesheetModel'
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
function entry(day: string, hours: number, over: Partial<TimeEntry> = {}): TimeEntry {
  const started = new Date(`${day}T08:00:00`)
  const ended = new Date(started.getTime() + hours * 3600_000)
  return {
    id: Math.floor(Math.random() * 1e9),
    userId: 1,
    userName: 'Test',
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    source: 'pin',
    terminalId: null,
    shiftId: null,
    breakMinutes: 0,
    note: null,
    editedByName: null,
    editedReason: null,
    approvedAt: null,
    minutes: hours * 60,
    ...over,
  }
}

let userId = 0
let roleId = 0

async function main() {
  /* ── Weeks ─────────────────────────────────────────────────────────── */
  //
  // Weeks run Monday to Sunday, which is what ordinary_hours_pw describes.
  console.log('\nweeks')
  // 2026-08-03 is a Monday; 2026-08-09 the Sunday that ends the same week.
  eq('Monday is its own week start', weekKey('2026-08-03'), '2026-08-03')
  eq('Wednesday belongs to that Monday', weekKey('2026-08-05'), '2026-08-03')
  eq('Sunday belongs to the week that STARTED, not the one beginning', weekKey('2026-08-09'), '2026-08-03')
  eq('the next Monday starts a new week', weekKey('2026-08-10'), '2026-08-10')

  eq('a range covers both ends', daysInRange('2026-08-03', '2026-08-05').length, 3)
  eq('a single day is one day', daysInRange('2026-08-03', '2026-08-03').length, 1)

  /* ── Banding ───────────────────────────────────────────────────────── */
  console.log('\nbanding')

  // Mon-Fri, 8 hours a day = 40. Under 45, so none of it is overtime.
  const normal = buildTimesheet(
    1,
    'Test',
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'].map((d) => entry(d, 8)),
    '2026-08-03',
    '2026-08-09',
    45,
  )
  eq('a 40-hour week is all ordinary', normal.ordinaryMinutes, 40 * 60)
  eq('and none of it overtime', normal.overtimeMinutes, 0)

  // THE POINT: a nine-hour Tuesday inside a 40-hour week is not overtime.
  const longDay = buildTimesheet(
    1,
    'Test',
    [entry('2026-08-03', 6), entry('2026-08-04', 9), entry('2026-08-05', 6), entry('2026-08-06', 6), entry('2026-08-07', 6)],
    '2026-08-03',
    '2026-08-09',
    45,
  )
  eq('a long day inside a short week is NOT overtime', longDay.overtimeMinutes, 0)
  eq('it is all ordinary', longDay.ordinaryMinutes, 33 * 60)

  // 50 hours across the week: 45 ordinary, 5 over.
  const overWeek = buildTimesheet(
    1,
    'Test',
    ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'].map((d) => entry(d, 10)),
    '2026-08-03',
    '2026-08-09',
    45,
  )
  eq('a 50-hour week caps ordinary at 45', overWeek.ordinaryMinutes, 45 * 60)
  eq('and bands the rest as overtime', overWeek.overtimeMinutes, 5 * 60)

  // A part-timer's overtime starts at THEIR week, not at 45.
  const partTime = buildTimesheet(
    1,
    'Test',
    ['2026-08-03', '2026-08-04', '2026-08-05'].map((d) => entry(d, 8)),
    '2026-08-03',
    '2026-08-09',
    20,
  )
  eq('a part-timer caps at their own hours', partTime.ordinaryMinutes, 20 * 60)
  eq('and the excess is overtime', partTime.overtimeMinutes, 4 * 60)

  // Two weeks band separately — 40 then 50 is 5 hours over, not 90 minus 45.
  const twoWeeks = buildTimesheet(
    1,
    'Test',
    [
      ...['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'].map((d) => entry(d, 8)),
      ...['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'].map((d) => entry(d, 10)),
    ],
    '2026-08-03',
    '2026-08-16',
    45,
  )
  eq('each week bands on its own', twoWeeks.overtimeMinutes, 5 * 60)
  eq('ordinary is 40 + 45', twoWeeks.ordinaryMinutes, 85 * 60)

  /* ── Sundays and holidays ──────────────────────────────────────────── */
  //
  // BCEA s16 gives Sunday its own rate whatever the week totals, so those
  // hours come out before the ordinary/overtime split.
  console.log('\npremium days')
  const sunday = buildTimesheet(
    1,
    'Test',
    [entry('2026-08-03', 8), entry('2026-08-09', 6)], // Monday + Sunday
    '2026-08-03',
    '2026-08-09',
    45,
  )
  eq('Sunday hours are premium', sunday.premiumMinutes, 6 * 60)
  eq('and are not counted as ordinary', sunday.ordinaryMinutes, 8 * 60)
  eq('nor as overtime', sunday.overtimeMinutes, 0)

  const holiday = buildTimesheet(
    1,
    'Test',
    [entry('2026-08-09', 5)],
    '2026-08-03',
    '2026-08-16',
    45,
    new Set(['2026-08-09']),
  )
  eq('a public holiday is premium too', holiday.premiumMinutes, 5 * 60)

  // A Sunday does NOT push a 45-hour week into overtime, because its hours
  // were already taken out.
  const sundayAfterFullWeek = buildTimesheet(
    1,
    'Test',
    [
      ...['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'].map((d) => entry(d, 9)),
      entry('2026-08-09', 4),
    ],
    '2026-08-03',
    '2026-08-09',
    45,
  )
  eq('a full week stays ordinary', sundayAfterFullWeek.ordinaryMinutes, 45 * 60)
  eq('the Sunday does not become overtime', sundayAfterFullWeek.overtimeMinutes, 0)
  eq('it is premium', sundayAfterFullWeek.premiumMinutes, 4 * 60)

  /* ── Payroll hours ─────────────────────────────────────────────────── */
  console.log('\npayroll hours')
  const hours = payrollHours(overWeek)
  eq('ordinary as decimal hours', hours.ordinary, 45)
  eq('overtime as decimal hours', hours.overtime, 5)
  eq('total', hours.total, 50)

  /* ── Approval rules ────────────────────────────────────────────────── */
  console.log('\napproval rules')
  const empty = buildTimesheet(1, 'Test', [], '2026-08-03', '2026-08-09', 45)
  check('an empty sheet cannot be approved', !canApprove(empty).ok, canApprove(empty).reason)

  const withOpen = buildTimesheet(
    1,
    'Test',
    [entry('2026-08-03', 8), { ...entry('2026-08-04', 0), endedAt: null, minutes: null }],
    '2026-08-03',
    '2026-08-09',
    45,
  )
  check(
    'a sheet with an open shift cannot be approved',
    !canApprove(withOpen).ok,
    canApprove(withOpen).reason,
  )

  check('a complete sheet can be', canApprove(normal).ok)

  const done = buildTimesheet(
    1,
    'Test',
    [entry('2026-08-03', 8, { approvedAt: new Date().toISOString() })],
    '2026-08-03',
    '2026-08-09',
    45,
  )
  check('an already-approved sheet says so', !canApprove(done).ok, canApprove(done).reason)

  /* ── Days ──────────────────────────────────────────────────────────── */
  console.log('\ndays')
  eq('every day in range appears, worked or not', normal.days.length, 7)
  eq('an unworked day is zero, not missing', normal.days[5].minutes, 0)
  check('an unworked day is not "approved"', !normal.days[5].approved)
  check('a Sunday is flagged', normal.days.find((d) => d.date === '2026-08-09')?.isSunday === true)

  /* ── End to end, against real rows ─────────────────────────────────── */
  console.log('\nend to end')
  const role = await siteExecute(
    SITE,
    `INSERT INTO roles (name, description) VALUES ('Test Sheet','Temporary, from the test script.')`,
  )
  roleId = role.insertId
  const made = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, role_id, is_active) VALUES ('Test Sheet','pos_only',?,1)`,
    [roleId],
  )
  userId = made.insertId

  // A part-timer, so the banding uses their hours rather than the default.
  await siteExecute(
    SITE,
    `INSERT INTO user_employment (user_id, pay_basis, hourly_rate, ordinary_hours_pw)
     VALUES (?, 'hourly', 50, 20)`,
    [userId],
  )

  // Monday and Tuesday, 8 hours each = 16, under their 20.
  for (const day of ['2026-08-03', '2026-08-04']) {
    await siteExecute(
      SITE,
      `INSERT INTO staff_time_entries (user_id, user_name, started_at, ended_at, source)
       VALUES (?, 'Test Sheet', ?, ?, 'manual')`,
      [userId, `${day} 08:00:00`, `${day} 16:00:00`],
    )
  }

  const [sheet] = await timesheetsFor(SITE, '2026-08-03', '2026-08-09', userId)
  check('a sheet comes back', !!sheet)
  eq('it uses THEIR ordinary hours, not 45', sheet?.ordinaryHoursPw, 20)
  eq('16 hours worked', sheet?.totalMinutes, 16 * 60)
  eq('all ordinary, under their 20', sheet?.overtimeMinutes, 0)

  /* ── Approving for real ────────────────────────────────────────────── */
  console.log('\napproving')
  const approved = await approveRange(SITE, userId, '2026-08-03', '2026-08-09', {
    userId: 1,
    userName: 'Test Manager',
  })
  check('the range approves', approved.ok, approved.ok ? `${approved.approved} entries` : approved.error)

  const after = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM staff_time_entries
      WHERE user_id = ? AND approved_at IS NOT NULL`,
    [userId],
  )
  eq('both entries are stamped', Number(after?.n), 2)

  const again = await approveRange(SITE, userId, '2026-08-03', '2026-08-09', {
    userId: 1,
    userName: 'Test Manager',
  })
  check('approving twice is refused', !again.ok, again.ok ? '' : again.error)

  // An open shift must block approval — the figure is still moving.
  await siteExecute(SITE, 'UPDATE staff_time_entries SET approved_at = NULL WHERE user_id = ?', [userId])
  await siteExecute(
    SITE,
    `INSERT INTO staff_time_entries (user_id, user_name, started_at, source)
     VALUES (?, 'Test Sheet', '2026-08-05 08:00:00', 'manual')`,
    [userId],
  )
  const blocked = await approveRange(SITE, userId, '2026-08-03', '2026-08-09', {
    userId: 1,
    userName: 'Test Manager',
  })
  check('an open shift blocks approval', !blocked.ok, blocked.ok ? '' : blocked.error)

  await siteExecute(
    SITE,
    `UPDATE staff_time_entries SET ended_at = '2026-08-05 12:00:00'
      WHERE user_id = ? AND ended_at IS NULL`,
    [userId],
  )
  check('closing it lets approval through', (await approveRange(SITE, userId, '2026-08-03', '2026-08-09', { userId: 1, userName: 'Test Manager' })).ok)

  const undone = await unapproveRange(SITE, userId, '2026-08-03', '2026-08-09')
  check('an approval can be taken back', undone.ok && undone.approved > 0)

  /* ── Public holidays ───────────────────────────────────────────────── */
  //
  // 2026-08-09 is National Women's Day, and it falls on a Sunday, so the
  // Monday is a holiday too under the Public Holidays Act s2(1).
  console.log('\npublic holidays')
  const holidayWeek = await timesheetsFor(SITE, '2026-08-03', '2026-08-16', userId)
  const monday10 = holidayWeek[0]?.days.find((d) => d.date === '2026-08-10')
  check(
    'a Sunday holiday moves the observance to the Monday',
    monday10?.isPublicHoliday === true,
    `2026-08-10 isPublicHoliday=${monday10?.isPublicHoliday}`,
  )
}

async function cleanup() {
  console.log('\ncleaning up...')
  if (userId) {
    await siteExecute(SITE, 'DELETE FROM staff_time_entries WHERE user_id = ?', [userId]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
  if (roleId) await siteExecute(SITE, 'DELETE FROM roles WHERE id = ?', [roleId]).catch(() => {})
  console.log('removed the test user and role')
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

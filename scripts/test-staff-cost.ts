/**
 * Cost per employee.
 *
 *   npm run test:staff-cost
 *
 * The point of the whole staff module. Three properties matter:
 *
 *   A LOCKED PERIOD DOES NOT MOVE. Once somebody has been paid, changing their
 *   rate must not restate what last month cost.
 *
 *   PAY DOES NOT LEAVE THE SERVER without `staff.cost` — same rule as the
 *   employment screen, because this is the same money.
 *
 *   NO RATE ON FILE IS NOT ZERO. Somebody with no employment row cannot be
 *   costed; showing zero would read as free labour.
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  costReport,
  createPayPeriod,
  calculatePayPeriod,
  lockPayPeriod,
  unlockPayPeriod,
  getPayPeriod,
  payLinesFor,
} from '../src/lib/site/staffCost'

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

// A quiet historic week, so nothing else in the database lands inside it.
const FROM = '2019-03-04' // Monday
const TO = '2019-03-10' // Sunday

let userId = 0
let bareId = 0
const periodIds: number[] = []
const actor = { userId: 1, userName: 'Test Manager' }

async function main() {
  /* ── Two people: one with terms, one without ───────────────────────── */
  const made = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('Test Costed','pos_only',1)`,
  )
  userId = made.insertId

  const bare = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('Test Uncosted','pos_only',1)`,
  )
  bareId = bare.insertId

  // R100/h, 45-hour week, so every figure below is arithmetic anybody can check.
  await siteExecute(
    SITE,
    `INSERT INTO user_employment (user_id, pay_basis, hourly_rate, ordinary_hours_pw, hired_on)
     VALUES (?, 'hourly', 100, 45, '2018-01-01')`,
    [userId],
  )

  // Mon–Fri, 10 hours each = 50 worked. 45 ordinary + 5 overtime.
  for (const day of ['2019-03-04', '2019-03-05', '2019-03-06', '2019-03-07', '2019-03-08']) {
    await siteExecute(
      SITE,
      `INSERT INTO staff_time_entries (user_id, user_name, started_at, ended_at, source)
       VALUES (?, 'Test Costed', ?, ?, 'manual')`,
      [userId, `${day} 08:00:00`, `${day} 18:00:00`],
    )
  }
  // Sunday, 4 hours — premium, and NOT overtime.
  await siteExecute(
    SITE,
    `INSERT INTO staff_time_entries (user_id, user_name, started_at, ended_at, source)
     VALUES (?, 'Test Costed', '2019-03-10 09:00:00', '2019-03-10 13:00:00', 'manual')`,
    [userId],
  )
  // The uncosted person works too, so "no rate" is tested against real hours.
  await siteExecute(
    SITE,
    `INSERT INTO staff_time_entries (user_id, user_name, started_at, ended_at, source)
     VALUES (?, 'Test Uncosted', '2019-03-04 08:00:00', '2019-03-04 16:00:00', 'manual')`,
    [bareId],
  )

  /* ── The arithmetic ────────────────────────────────────────────────── */
  console.log('\ncost arithmetic')
  const report = await costReport(SITE, FROM, TO, true)
  const line = report.lines.find((l) => l.userId === userId)!
  check('the costed person appears', !!line)

  eq('45 ordinary hours', line.ordinaryHours, 45)
  eq('5 overtime hours', line.overtimeHours, 5)
  eq('4 premium hours', line.premiumHours, 4)

  // 45 × 100 = 4500
  eq('ordinary at the plain rate', line.ordinaryCost, 4500)
  // 5 × 100 × 1.5 = 750 — BCEA s10
  eq('overtime at one and a half', line.overtimeCost, 750)
  // 4 × 100 × 2 = 800 — BCEA s16
  eq('Sunday at double', line.premiumCost, 800)
  eq('and the total adds up', line.totalCost, 4500 + 750 + 800)

  /* ── No rate on file is not zero ───────────────────────────────────── */
  console.log('\nno rate on file')
  const bareLine = report.lines.find((l) => l.userId === bareId)!
  check('somebody with no terms still appears', !!bareLine)
  check('flagged as having no rate', bareLine.noRateOnFile === true)
  check('their cost is null, not zero', bareLine.totalCost === null)
  eq('but their hours are counted', bareLine.ordinaryHours, 8)

  /* ── Pay is hidden without the capability ──────────────────────────── */
  console.log('\npay visibility')
  const hidden = await costReport(SITE, FROM, TO, false)
  const hiddenLine = hidden.lines.find((l) => l.userId === userId)!

  check('the rate is null', hiddenLine.hourlyRate === null)
  check('every cost column is null', hiddenLine.totalCost === null && hiddenLine.ordinaryCost === null)
  check('commission is null', hiddenLine.commission === null)
  check('contribution is null', hiddenLine.contribution === null)
  check('the report total is null', hidden.totalCost === null)
  // Hiding in JSX still ships it in the RSC payload, so the figure must not be
  // anywhere on the object at all.
  check(
    'no cost figure is hiding on the object',
    !JSON.stringify(hiddenLine).includes('4500'),
    JSON.stringify(hiddenLine).slice(0, 100),
  )
  eq('hours still come through', hiddenLine.ordinaryHours, 45)

  /* ── Periods ───────────────────────────────────────────────────────── */
  console.log('\npay periods')
  const opened = await createPayPeriod(SITE, FROM, TO, 'Test period')
  check('a period can be opened', opened.ok, opened.ok ? '' : opened.error)
  if (!opened.ok) throw new Error('need a period')
  periodIds.push(opened.id)

  const overlap = await createPayPeriod(SITE, '2019-03-06', '2019-03-12', null)
  check('an overlapping period is refused', !overlap.ok, overlap.ok ? '' : overlap.error)
  if (overlap.ok) periodIds.push(overlap.id)

  const backwards = await createPayPeriod(SITE, '2019-05-10', '2019-05-01', null)
  check('a backwards period is refused', !backwards.ok)
  if (backwards.ok) periodIds.push(backwards.id)

  const tooEarly = await lockPayPeriod(SITE, opened.id, actor)
  check('an uncalculated period cannot be locked', !tooEarly.ok, tooEarly.ok ? '' : tooEarly.error)

  /* ── Calculating freezes the figures ───────────────────────────────── */
  console.log('\ncalculating')
  const calc = await calculatePayPeriod(SITE, opened.id)
  check('the period calculates', calc.ok, calc.ok ? `${calc.people} people, ${calc.total}` : calc.error)

  const frozen = await payLinesFor(SITE, opened.id, true)
  const frozenLine = frozen.find((l) => l.userId === userId)!
  check('a line was frozen', !!frozenLine)
  eq('with the same total', frozenLine.totalCost, 6050)
  eq('and the rate it was costed at', frozenLine.hourlyRate, 100)

  // Somebody with no terms is skipped, not frozen at zero — a zero would read
  // as free labour a year from now.
  check(
    'the uncosted person is not frozen at zero',
    !frozen.some((l) => l.userId === bareId),
  )

  const period = await getPayPeriod(SITE, opened.id)
  check('the period records when it was calculated', !!period?.calculatedAt)
  eq('and carries the header total', period?.totalCost, 6050)

  /* ── THE PROPERTY THAT MATTERS ─────────────────────────────────────── */
  //
  // Once somebody has been paid, changing their rate must not restate it.
  console.log('\nlocked means locked')
  const locked = await lockPayPeriod(SITE, opened.id, actor)
  check('a calculated period locks', locked.ok, locked.ok ? '' : locked.error)
  check('and reads as locked', (await getPayPeriod(SITE, opened.id))?.status === 'locked')

  const recalc = await calculatePayPeriod(SITE, opened.id)
  check(
    'a LOCKED period refuses to recalculate',
    !recalc.ok,
    recalc.ok ? 'IT RECALCULATED — a paid figure can move' : recalc.error,
  )

  // Give them a raise and confirm the locked period ignores it entirely.
  await siteExecute(SITE, 'UPDATE user_employment SET hourly_rate = 250 WHERE user_id = ?', [userId])

  const afterRaise = await payLinesFor(SITE, opened.id, true)
  eq(
    'a raise does not restate a locked period',
    afterRaise.find((l) => l.userId === userId)?.totalCost,
    6050,
  )
  eq(
    'and the rate it was costed at is still on the line',
    afterRaise.find((l) => l.userId === userId)?.hourlyRate,
    100,
  )

  // But a LIVE report does reflect it, which is the whole distinction.
  const live = await costReport(SITE, FROM, TO, true)
  eq(
    'while a live report uses the new rate',
    live.lines.find((l) => l.userId === userId)?.ordinaryCost,
    45 * 250,
  )

  const relock = await lockPayPeriod(SITE, opened.id, actor)
  check('locking twice is refused', !relock.ok)

  /* ── Reopening ─────────────────────────────────────────────────────── */
  console.log('\nreopening')
  check('a locked period can be deliberately reopened', (await unlockPayPeriod(SITE, opened.id)).ok)
  check('and recalculates again', (await calculatePayPeriod(SITE, opened.id)).ok)

  const reopened = await payLinesFor(SITE, opened.id, true)
  eq(
    'picking up the new rate',
    reopened.find((l) => l.userId === userId)?.totalCost,
    round2(45 * 250 + 5 * 250 * 1.5 + 4 * 250 * 2),
  )

  /* ── Frozen lines hide pay too ─────────────────────────────────────── */
  console.log('\nfrozen lines respect the capability')
  const frozenHidden = await payLinesFor(SITE, opened.id, false)
  const fh = frozenHidden.find((l) => l.userId === userId)!
  check('the frozen rate is null without staff.cost', fh.hourlyRate === null)
  check('and so is the total', fh.totalCost === null)
  eq('but the hours are still there', fh.ordinaryHours, 45)

  /* ── Leave costs money ─────────────────────────────────────────────── */
  console.log('\nleave')
  const annual = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM leave_types WHERE code = 'ANNUAL' LIMIT 1`,
  )
  if (annual) {
    await siteExecute(SITE, 'UPDATE user_employment SET hourly_rate = 100 WHERE user_id = ?', [userId])
    await siteExecute(
      SITE,
      `INSERT INTO leave_requests
         (user_id, user_name, leave_type_id, leave_type_name, period_from, period_to, days, status)
       VALUES (?, 'Test Costed', ?, 'Annual leave', '2019-03-06', '2019-03-06', 1, 'approved')`,
      [userId, annual.id],
    )

    const withLeave = await costReport(SITE, FROM, TO, true)
    const l = withLeave.lines.find((x) => x.userId === userId)!
    eq('a paid leave day is counted', l.leaveDays, 1)
    // A leave day costs the ordinary week / 5 = 9 hours at R100.
    eq('and costs a normal working day', l.leaveCost, 900)
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

async function cleanup() {
  console.log('\ncleaning up...')
  for (const id of periodIds) {
    await siteExecute(SITE, 'DELETE FROM staff_pay_periods WHERE id = ?', [id]).catch(() => {})
  }
  for (const id of [userId, bareId].filter(Boolean)) {
    await siteExecute(SITE, 'DELETE FROM leave_requests WHERE user_id = ?', [id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM staff_time_entries WHERE user_id = ?', [id]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [id]).catch(() => {})
  }
  console.log('removed the test users and period')
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

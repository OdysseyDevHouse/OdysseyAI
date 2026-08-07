/**
 * Leave — entitlement, balances, requests.
 *
 *   npm run test:leave
 *
 * Two properties matter more than the rest:
 *
 *   ACCRUAL IS IDEMPOTENT. A job on a timer WILL run twice eventually — a
 *   retry, a manual trigger, two app instances. Doubling everybody's leave is
 *   not a mistake anyone notices quickly.
 *
 *   THE BALANCE IS A SUM, NEVER A STORED NUMBER. The first time somebody says
 *   "I should have fourteen days", the answer has to be a list of movements.
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  listLeaveTypes,
  balancesFor,
  ledgerFor,
  accrueAll,
  requestLeave,
  approveRequest,
  declineRequest,
  cancelRequest,
  adjustBalance,
  listRequests,
} from '../src/lib/site/leave'
import {
  workingDaysBetween,
  monthsWorked,
  entitlementToDate,
  formatDays,
} from '../src/lib/leaveModel'

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

let userId = 0
const actor = { userId: 1, userName: 'Test Manager' }

async function main() {
  /* ── Working days ──────────────────────────────────────────────────── */
  console.log('\nworking days')
  // 2026-08-03 Mon to 2026-08-07 Fri.
  eq('a working week is five days', workingDaysBetween('2026-08-03', '2026-08-07'), 5)
  eq('a full calendar week is still five', workingDaysBetween('2026-08-03', '2026-08-09'), 5)
  eq('one day', workingDaysBetween('2026-08-03', '2026-08-03'), 1)
  eq('a weekend alone is nothing', workingDaysBetween('2026-08-08', '2026-08-09'), 0)
  eq('backwards is nothing', workingDaysBetween('2026-08-07', '2026-08-03'), 0)

  // A store trading Saturdays that did not count them would quietly give
  // everybody an extra day of leave per week taken.
  eq(
    'a six-day store counts Saturday',
    workingDaysBetween('2026-08-03', '2026-08-09', new Set([1, 2, 3, 4, 5, 6])),
    6,
  )

  // BCEA s20(3): annual leave may not run concurrently with a public holiday.
  eq(
    'a public holiday in the range does not cost a leave day',
    workingDaysBetween('2026-08-03', '2026-08-07', new Set([1, 2, 3, 4, 5]), new Set(['2026-08-05'])),
    4,
  )

  /* ── Months worked ─────────────────────────────────────────────────── */
  console.log('\nmonths worked')
  eq('a whole month', monthsWorked('2026-01-15', '2026-02-15'), 1)
  // The anniversary has to pass — accruing a part month would mean the balance
  // moves every day and cannot be explained to the person holding it.
  eq('a day short of the anniversary does not count', monthsWorked('2026-01-15', '2026-02-14'), 0)
  eq('a year', monthsWorked('2026-01-15', '2027-01-15'), 12)
  eq('before they started is nothing', monthsWorked('2026-06-01', '2026-01-01'), 0)

  /* ── Entitlement ───────────────────────────────────────────────────── */
  console.log('\nentitlement')
  const annual = { accrualMethod: 'monthly' as const, accrualDays: 1.25, cycleMonths: 12 }
  eq('one month of annual leave', entitlementToDate(annual, '2026-01-15', '2026-02-15'), 1.25)
  eq('a full year', entitlementToDate(annual, '2026-01-15', '2027-01-15'), 15)
  eq('nothing before the first month is up', entitlementToDate(annual, '2026-01-15', '2026-02-01'), 0)

  const sick = { accrualMethod: 'cycle_36m' as const, accrualDays: 30, cycleMonths: 36 }
  // s22 gives the whole block from the start of the cycle, not accrued through it.
  eq('sick leave arrives whole', entitlementToDate(sick, '2026-01-01', '2026-03-01'), 30)
  // NOT cumulative. The entitlement is 30 days PER CYCLE and the previous
  // cycle's balance lapses — somebody employed nine years has 30 days, not 90.
  // Multiplying by cycles would hand them three months of paid sick leave the
  // Act does not give, discovered only when somebody took it.
  eq('nine years still gives one block', entitlementToDate(sick, '2017-01-01', '2026-01-01'), 30)
  eq('and so does one month', entitlementToDate(sick, '2025-12-01', '2026-01-01'), 30)

  const family = { accrualMethod: 'annual_grant' as const, accrualDays: 3, cycleMonths: 12 }
  eq('family leave is granted yearly', entitlementToDate(family, '2026-01-01', '2026-06-01'), 3)
  eq('and again the next year', entitlementToDate(family, '2026-01-01', '2027-06-01'), 6)

  eq('unpaid accrues nothing', entitlementToDate({ accrualMethod: 'none', accrualDays: 0, cycleMonths: 12 }, '2020-01-01', '2026-01-01'), 0)

  console.log('\nformatting')
  eq('half a day reads as words', formatDays(0.5), 'half a day')
  eq('one day is singular', formatDays(1), '1 day')
  eq('more is plural', formatDays(3), '3 days')

  /* ── The seeded types ──────────────────────────────────────────────── */
  console.log('\nseeded types')
  const types = await listLeaveTypes(SITE, true)
  const byCode = new Map(types.map((t) => [t.code, t]))

  check('annual leave is seeded', !!byCode.get('ANNUAL'))
  eq('at the BCEA monthly rate', byCode.get('ANNUAL')?.accrualDays, 1.25)
  eq('sick leave is 30 days', byCode.get('SICK')?.accrualDays, 30)
  eq('over a 36-month cycle', byCode.get('SICK')?.cycleMonths, 36)
  eq('family responsibility is 3 days', byCode.get('FAMILY')?.accrualDays, 3)
  // The employer is not obliged to pay maternity — UIF is. Marking it paid
  // would commit a store to a cost the law does not impose.
  check('maternity is UNPAID by the employer', byCode.get('MATERNITY')?.isPaid === false)
  check('unpaid leave accrues nothing', byCode.get('UNPAID')?.accrualMethod === 'none')

  /* ── A person to test with ─────────────────────────────────────────── */
  const made = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('Test Leaver','pos_only',1)`,
  )
  userId = made.insertId

  // Hired a year and a bit ago, so a full year of annual leave has accrued.
  await siteExecute(
    SITE,
    `INSERT INTO user_employment (user_id, pay_basis, hourly_rate, hired_on, leave_cycle_start)
     VALUES (?, 'hourly', 50, '2025-01-15', '2025-01-15')`,
    [userId],
  )

  /* ── Accrual ───────────────────────────────────────────────────────── */
  console.log('\naccrual')
  const first = await accrueAll(SITE, '2026-01-15', actor)
  check('accrual runs', first.ok, first.ok ? `${first.posted} postings` : first.error)

  let balances = await balancesFor(SITE, userId)
  const annualBalance = balances.find((b) => b.leaveTypeName === 'Annual leave')
  eq('a year of annual leave accrued', annualBalance?.accrued, 15)
  eq('none of it used', annualBalance?.used, 0)
  eq('so the balance is 15', annualBalance?.balance, 15)

  // THE PROPERTY THAT MATTERS: running it again posts nothing.
  const second = await accrueAll(SITE, '2026-01-15', actor)
  check('a second run posts nothing', second.ok && second.posted === 0, second.ok ? `${second.posted}` : second.error)

  balances = await balancesFor(SITE, userId)
  eq('and the balance is unchanged', balances.find((b) => b.leaveTypeName === 'Annual leave')?.accrued, 15)

  // Running later tops up the difference rather than starting again.
  await accrueAll(SITE, '2026-03-15', actor)
  balances = await balancesFor(SITE, userId)
  eq('two more months tops up to 17.5', balances.find((b) => b.leaveTypeName === 'Annual leave')?.accrued, 17.5)

  /* ── Requesting ────────────────────────────────────────────────────── */
  console.log('\nrequesting')
  const annualType = byCode.get('ANNUAL')!

  const booked = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-04-06',
    periodTo: '2026-04-10',
    isHalfDay: false,
    reason: 'Family visit',
  })
  check('leave can be booked', booked.ok, booked.ok ? `${booked.days} days` : booked.error)
  eq('a working week counts as five days', booked.ok ? booked.days : 0, 5)

  const overlap = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-04-08',
    periodTo: '2026-04-09',
    isHalfDay: false,
    reason: null,
  })
  check('overlapping leave is refused', !overlap.ok, overlap.ok ? '' : overlap.error)

  const backwards = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-05-10',
    periodTo: '2026-05-01',
    isHalfDay: false,
    reason: null,
  })
  check('a backwards range is refused', !backwards.ok)

  const weekendOnly = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-05-09',
    periodTo: '2026-05-10',
    isHalfDay: false,
    reason: null,
  })
  check('a weekend-only request is refused', !weekendOnly.ok, weekendOnly.ok ? '' : weekendOnly.error)

  const tooMuch = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-06-01',
    periodTo: '2026-08-31',
    isHalfDay: false,
    reason: null,
  })
  check('more than the balance is refused', !tooMuch.ok, tooMuch.ok ? '' : tooMuch.error)

  // Unpaid is never refused on balance — that is the point of it.
  const unpaid = await requestLeave(SITE, {
    userId,
    leaveTypeId: byCode.get('UNPAID')!.id,
    periodFrom: '2026-09-01',
    periodTo: '2026-09-30',
    isHalfDay: false,
    reason: 'No paid leave left',
  })
  check('unpaid leave is never refused on balance', unpaid.ok, unpaid.ok ? '' : unpaid.error)

  const half = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-05-06',
    periodTo: '2026-05-06',
    isHalfDay: true,
    reason: 'Dentist',
  })
  check('a half day can be booked', half.ok, half.ok ? `${half.days}` : half.error)
  eq('and counts as 0.5', half.ok ? half.days : 0, 0.5)

  const spanningHalf = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-05-11',
    periodTo: '2026-05-12',
    isHalfDay: true,
    reason: null,
  })
  check('a half day across two dates is refused', !spanningHalf.ok, spanningHalf.ok ? '' : spanningHalf.error)

  /* ── Approving ─────────────────────────────────────────────────────── */
  console.log('\napproving')
  if (!booked.ok) throw new Error('need the booked request')

  const before = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  const approved = await approveRequest(SITE, booked.id, actor, 'Enjoy')
  check('a request can be approved', approved.ok, approved.ok ? '' : approved.error)

  const after = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  eq('the days come off the balance', after.balance, before.balance - 5)
  eq('and show as used', after.used, before.used + 5)

  const twice = await approveRequest(SITE, booked.id, actor, null)
  check('approving twice is refused', !twice.ok, twice.ok ? '' : twice.error)

  // The ledger must explain the balance — that is the whole reason for it.
  const ledger = await ledgerFor(SITE, userId, annualType.id)
  check('the ledger shows the accrual', ledger.some((e) => e.source === 'accrual'))
  check('and the leave taken', ledger.some((e) => e.source === 'taken' && e.days === -5))

  /* ── Cancelling gives the days back ────────────────────────────────── */
  console.log('\ncancelling')
  const cancelled = await cancelRequest(SITE, booked.id, actor)
  check('approved leave can be cancelled', cancelled.ok, cancelled.ok ? '' : cancelled.error)

  const restored = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  eq('the days come back', restored.balance, before.balance)

  const afterCancel = await ledgerFor(SITE, userId, annualType.id)
  check(
    'and no +5/−5 pair is left behind',
    !afterCancel.some((e) => e.source === 'taken' && e.days === -5),
  )

  /* ── Declining ─────────────────────────────────────────────────────── */
  console.log('\ndeclining')
  const toDecline = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2026-07-06',
    periodTo: '2026-07-07',
    isHalfDay: false,
    reason: null,
  })
  if (!toDecline.ok) throw new Error('need a request to decline')

  const beforeDecline = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  check('a request can be declined', (await declineRequest(SITE, toDecline.id, actor, 'Too busy')).ok)
  const afterDecline = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  eq('a declined request costs nothing', afterDecline.balance, beforeDecline.balance)

  /* ── Adjustments ───────────────────────────────────────────────────── */
  console.log('\nadjustments')
  const noReason = await adjustBalance(SITE, userId, annualType.id, 2, '', 'adjustment', actor)
  check('an adjustment with no reason is refused', !noReason.ok, noReason.ok ? '' : noReason.error)

  const zero = await adjustBalance(SITE, userId, annualType.id, 0, 'Nothing', 'adjustment', actor)
  check('an adjustment of zero is refused', !zero.ok)

  const beforeAdjust = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  check(
    'a manager can adjust a balance',
    (await adjustBalance(SITE, userId, annualType.id, 2, 'Goodwill day', 'adjustment', actor)).ok,
  )
  const afterAdjust = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
  eq('the adjustment lands', afterAdjust.balance, beforeAdjust.balance + 2)

  /* ── Pending is committed but not taken ────────────────────────────── */
  //
  // Approved leave in the future is not in the ledger — a ledger entry says
  // something happened, and December has not. But it IS committed, so
  // `available` must subtract it or somebody books the same days twice.
  console.log('\npending')
  const future = await requestLeave(SITE, {
    userId,
    leaveTypeId: annualType.id,
    periodFrom: '2099-06-01',
    periodTo: '2099-06-05',
    isHalfDay: false,
    reason: 'Far off',
  })
  if (future.ok) {
    await approveRequest(SITE, future.id, actor, null)
    const withPending = (await balancesFor(SITE, userId)).find((b) => b.leaveTypeId === annualType.id)!
    eq('future leave shows as pending', withPending.pending, 5)
    eq(
      'and is subtracted from what they could book today',
      withPending.available,
      withPending.balance - 5,
    )
  }

  /* ── Terminated staff stop accruing ────────────────────────────────── */
  console.log('\ntermination')
  await siteExecute(SITE, `UPDATE user_employment SET terminated_on = '2026-02-15' WHERE user_id = ?`, [userId])
  await siteExecute(SITE, `DELETE FROM leave_ledger WHERE user_id = ? AND source = 'accrual'`, [userId])
  await accrueAll(SITE, '2026-12-31', actor)

  // Compared against the ACCRUAL movements alone. `accrued` on a balance also
  // includes the goodwill adjustment made earlier, so summing it here would be
  // measuring two different things at once.
  const accrualOnly = await siteQueryOne<{ total: string | null }>(
    SITE,
    `SELECT SUM(days) AS total FROM leave_ledger
      WHERE user_id = ? AND leave_type_id = ? AND source = 'accrual'`,
    [userId, annualType.id],
  )
  // Hired 2025-01-15, left 2026-02-15 = 13 months × 1.25 = 16.25. Not the 23.75
  // that running to 2026-12-31 would give somebody still employed.
  eq('accrual stops on the last day worked', Number(accrualOnly?.total), 16.25)

  const requests = await listRequests(SITE, { userId })
  check('their requests are still on file', requests.length > 0, `${requests.length}`)
}

async function cleanup() {
  console.log('\ncleaning up...')
  if (userId) {
    await siteExecute(SITE, 'DELETE FROM leave_ledger WHERE user_id = ?', [userId]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM leave_requests WHERE user_id = ?', [userId]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
  console.log('removed the test user')
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

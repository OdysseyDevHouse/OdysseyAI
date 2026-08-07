/**
 * Employment terms — rate visibility, BCEA limits, hourly cost.
 *
 *   npm run test:employment
 *
 * Two things matter more than the rest:
 *
 *   A PAY RATE MUST NOT LEAVE THE SERVER without `staff.cost`. Hiding it in
 *   JSX still ships it in the RSC payload, one devtools tab away from the shop
 *   floor. `withCost = false` has to return null, not a number.
 *
 *   ORDINARY HOURS CANNOT EXCEED 45. Above that every hour is ordinary and
 *   none is ever overtime — wrong arithmetically and unlawful as a standing
 *   pattern (BCEA s9).
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  saveEmployment,
  getEmployment,
  listEmployment,
  hourlyCostOf,
  BCEA_ORDINARY_HOURS_PW,
  type EmploymentInput,
} from '../src/lib/site/employment'

const SITE = 1
let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function eq(label: string, actual: number | null, expected: number, tolerance = 0.01) {
  const ok = actual !== null && Math.abs(actual - expected) <= tolerance
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} — got ${actual}, expected ${expected}`)
  if (!ok) failures++
}

const base: EmploymentInput = {
  employeeNumber: null,
  employmentType: 'permanent',
  payBasis: 'hourly',
  hourlyRate: 45,
  monthlySalary: 0,
  ordinaryHoursPw: 45,
  worksSundays: false,
  hiredOn: '2024-03-01',
  terminatedOn: null,
  leaveCycleStart: null,
  notes: null,
}

let userId = 0
let otherId = 0

async function main() {
  // Two throwaway users, so nothing here depends on who happens to be on file.
  const made = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('Test Employee','pos_only',1)`,
  )
  userId = made.insertId
  const other = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, is_active) VALUES ('Test Employee 2','pos_only',1)`,
  )
  otherId = other.insertId

  /* ── Saving ────────────────────────────────────────────────────────── */
  console.log('\nsaving')
  check('terms can be saved for a user with none', (await saveEmployment(SITE, userId, base)).ok)
  check(
    'saving again updates rather than duplicating',
    (await saveEmployment(SITE, userId, { ...base, hourlyRate: 50 })).ok,
  )

  const saved = await getEmployment(SITE, userId, true)
  eq('the second save took effect', saved?.hourlyRate ?? null, 50)

  const ghost = await saveEmployment(SITE, 999999, base)
  check('a user who does not exist is refused', !ghost.ok, ghost.ok ? '' : ghost.error)

  /* ── Rate visibility ───────────────────────────────────────────────── */
  //
  // The whole point of the withCost flag.
  console.log('\nrate visibility')
  const withCost = await getEmployment(SITE, userId, true)
  check('with staff.cost the rate is a number', withCost?.hourlyRate === 50)

  const without = await getEmployment(SITE, userId, false)
  check('without staff.cost the hourly rate is null', without?.hourlyRate === null)
  check('without staff.cost the salary is null', without?.monthlySalary === null)
  check(
    'the rate is not hiding elsewhere on the object',
    !JSON.stringify(without).includes('50'),
    JSON.stringify(without).slice(0, 90),
  )
  check('everything else still comes back', without?.employmentType === 'permanent')

  const listed = await listEmployment(SITE, false)
  check(
    'the list hides rates too',
    listed.every((e) => e.hourlyRate === null && e.monthlySalary === null),
  )

  /* ── BCEA limits ───────────────────────────────────────────────────── */
  console.log('\nBCEA limits')
  const tooMany = await saveEmployment(SITE, userId, { ...base, ordinaryHoursPw: 50 })
  check(
    `more than ${BCEA_ORDINARY_HOURS_PW} ordinary hours is refused`,
    !tooMany.ok,
    tooMany.ok ? '' : tooMany.error,
  )

  check(
    'exactly 45 is allowed',
    (await saveEmployment(SITE, userId, { ...base, ordinaryHoursPw: 45 })).ok,
  )
  check(
    'a part-timer on 20 is allowed',
    (await saveEmployment(SITE, userId, { ...base, ordinaryHoursPw: 20 })).ok,
  )
  check('zero hours is refused', !(await saveEmployment(SITE, userId, { ...base, ordinaryHoursPw: 0 })).ok)
  check('a negative rate is refused', !(await saveEmployment(SITE, userId, { ...base, hourlyRate: -1 })).ok)

  const backwards = await saveEmployment(SITE, userId, {
    ...base,
    hiredOn: '2024-06-01',
    terminatedOn: '2024-01-01',
  })
  check('ending before starting is refused', !backwards.ok, backwards.ok ? '' : backwards.error)

  /* ── Employee number ───────────────────────────────────────────────── */
  console.log('\nemployee number')
  check(
    'a number can be set',
    (await saveEmployment(SITE, userId, { ...base, employeeNumber: 'EMP001' })).ok,
  )
  const dup = await saveEmployment(SITE, otherId, { ...base, employeeNumber: 'EMP001' })
  check('two people cannot share one', !dup.ok, dup.ok ? '' : dup.error)
  check(
    'the same person keeping their own number is fine',
    (await saveEmployment(SITE, userId, { ...base, employeeNumber: 'EMP001' })).ok,
  )

  /* ── Leave cycle ───────────────────────────────────────────────────── */
  //
  // BCEA s20 measures the annual entitlement from the start of employment.
  console.log('\nleave cycle')
  await saveEmployment(SITE, userId, { ...base, hiredOn: '2024-03-01', leaveCycleStart: null })
  const cycled = await getEmployment(SITE, userId, true)
  check(
    'the cycle follows the hire date when not set',
    cycled?.leaveCycleStart?.slice(0, 10) === '2024-03-01',
    cycled?.leaveCycleStart ?? 'null',
  )

  await saveEmployment(SITE, userId, {
    ...base,
    hiredOn: '2024-03-01',
    leaveCycleStart: '2024-01-01',
  })
  const overridden = await getEmployment(SITE, userId, true)
  check(
    'a store can run everybody on a common cycle instead',
    overridden?.leaveCycleStart?.slice(0, 10) === '2024-01-01',
  )

  /* ── Hourly cost ───────────────────────────────────────────────────── */
  console.log('\nhourly cost')
  await saveEmployment(SITE, userId, { ...base, payBasis: 'hourly', hourlyRate: 45 })
  eq('an hourly person costs their rate', hourlyCostOf((await getEmployment(SITE, userId, true))!), 45)

  // 20 000 / (45 × 52/12) = 20 000 / 195 = 102.56
  await saveEmployment(SITE, userId, {
    ...base,
    payBasis: 'salaried',
    hourlyRate: 0,
    monthlySalary: 20000,
    ordinaryHoursPw: 45,
  })
  eq(
    'a salaried person costs the month divided out',
    hourlyCostOf((await getEmployment(SITE, userId, true))!),
    20000 / (45 * (52 / 12)),
  )

  // The reason pay_basis is stored rather than inferred: this person has BOTH
  // figures on file, and "whichever is non-zero" would pay them twice.
  await saveEmployment(SITE, userId, {
    ...base,
    payBasis: 'salaried',
    hourlyRate: 45,
    monthlySalary: 20000,
  })
  const both = await getEmployment(SITE, userId, true)
  eq(
    'with both rates on file, pay_basis decides',
    hourlyCostOf(both!),
    20000 / (45 * (52 / 12)),
  )

  const hidden = await getEmployment(SITE, userId, false)
  check('cost cannot be derived without the capability', hourlyCostOf(hidden!) === null)

  /* ── Termination ───────────────────────────────────────────────────── */
  //
  // A person who left still worked the months before they did. The row stays.
  console.log('\ntermination')
  await saveEmployment(SITE, userId, { ...base, terminatedOn: '2024-12-31' })
  const gone = await getEmployment(SITE, userId, true)
  check('a terminated person is still on file', !!gone)
  check('and reads as not current', gone?.isCurrent === false)

  await saveEmployment(SITE, userId, { ...base, terminatedOn: null })
  check('reinstating clears it', (await getEmployment(SITE, userId, true))?.isCurrent === true)

  /* ── Deleting the user ─────────────────────────────────────────────── */
  console.log('\ncascade')
  await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [otherId])
  const orphan = await siteQueryOne(
    SITE,
    'SELECT user_id FROM user_employment WHERE user_id = ?',
    [otherId],
  )
  check('deleting a user takes their terms with them', orphan === null)
  otherId = 0
}

async function cleanup() {
  console.log('\ncleaning up...')
  for (const id of [userId, otherId].filter(Boolean)) {
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

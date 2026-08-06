/**
 * Users, roles, PINs.
 *
 *   npx tsx --env-file=.env scripts/test-users-pins.ts
 *
 * Proves the parts that cannot be checked by looking at a screen: that a PIN
 * is stored only as a hash, that a duplicate is refused, that PIN sign-in
 * finds the right person, and that capabilities resolve deny-by-default.
 *
 * Writes to site 1 and cleans up after itself.
 */
import {
  createUser,
  updateUser,
  getUser,
  listUsers,
  signInWithPin,
  clearPin,
} from '../src/lib/site/users'
import {
  listRoles,
  createRole,
  deleteRole,
  setCapability,
  capabilitiesForRole,
  can,
  CAPABILITIES,
} from '../src/lib/site/permissions'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1
let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const created: number[] = []
const createdRoles: number[] = []

async function main() {
  console.log(`\n${CAPABILITIES.length} capabilities defined\n`)

  // ── Roles ──────────────────────────────────────────────────────────────
  const roles = await listRoles(SITE)
  const owner = roles.find((r) => r.isOwner)
  check('an owner role exists', !!owner, owner?.name)
  check('owner is ordered first', roles[0]?.isOwner === true)

  const ownerCaps = await capabilitiesForRole(SITE, owner!.id)
  check('owner holds every capability implicitly', ownerCaps.isOwner)
  check('owner passes a capability it has no row for', can(ownerCaps, 'setup.users'))

  const cashier = roles.find((r) => r.name === 'Cashier')
  const cashierCaps = await capabilitiesForRole(SITE, cashier!.id)
  check('cashier may use the till', can(cashierCaps, 'sales.till'))
  check('cashier may NOT void a sale', !can(cashierCaps, 'sales.void'))
  check('cashier may NOT manage users', !can(cashierCaps, 'setup.users'))

  const noRole = await capabilitiesForRole(SITE, null)
  check('a user with no role can do nothing', !can(noRole, 'sales.till'))

  // Owner cannot be reduced — the anti-lockout rule.
  const reduce = await setCapability(SITE, owner!.id, 'setup.users', false)
  check('owner cannot have a permission removed', !reduce.ok, reduce.ok ? '' : reduce.error)

  const newRole = await createRole(SITE, 'Test Supervisor', 'Temporary, from the test script.')
  check('a role can be created', newRole.ok)
  if (newRole.ok) {
    createdRoles.push(newRole.id)
    await setCapability(SITE, newRole.id, 'sales.void', true)
    const caps = await capabilitiesForRole(SITE, newRole.id)
    check('granted capability resolves', can(caps, 'sales.void'))
    check('ungranted capability stays denied', !can(caps, 'sales.credit_note'))
  }

  const dupRole = await createRole(SITE, 'Test Supervisor', null)
  check('duplicate role name refused', !dupRole.ok, dupRole.ok ? '' : dupRole.error)

  // ── PINs ───────────────────────────────────────────────────────────────
  console.log('')
  const pos = await createUser(SITE, {
    name: 'Test Cashier',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: '4827',
    isActive: true,
  })
  check('a POS-only user can be created with a PIN', pos.ok, pos.ok ? '' : pos.error)
  if (!pos.ok) throw new Error('cannot continue without a user')
  created.push(pos.id)

  const row = await siteQueryOne<{ pin_hash: string }>(
    SITE,
    'SELECT pin_hash FROM users WHERE id = ?',
    [pos.id],
  )
  check('the PIN is not stored in plaintext', !row?.pin_hash?.includes('4827'))
  check('the PIN is stored as a bcrypt hash', /^\$2[aby]\$/.test(row?.pin_hash ?? ''))

  const stored = await getUser(SITE, pos.id)
  check('hasPin is reported without exposing the hash', stored?.hasPin === true)
  check('the hash is not on the returned object', !JSON.stringify(stored).includes('$2'))

  // Uniqueness — the whole basis of PIN-only sign-in.
  const clash = await createUser(SITE, {
    name: 'Test Clash',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: '4827',
    isActive: true,
  })
  check('a duplicate PIN is refused', !clash.ok, clash.ok ? '' : clash.error)
  if (clash.ok) created.push(clash.id)

  for (const [pin, why] of [
    ['1111', 'repeated digits'],
    ['1234', 'consecutive digits'],
    ['123', 'too short'],
    ['12345', 'five digits'],
    ['abcd', 'not numeric'],
  ] as const) {
    const bad = await createUser(SITE, {
      name: `Test Bad ${pin}`,
      email: null,
      userType: 'pos_only',
      roleId: cashier!.id,
      salesRepId: null,
      pin,
      isActive: true,
    })
    check(`PIN "${pin}" refused (${why})`, !bad.ok)
    if (bad.ok) created.push(bad.id)
  }

  const sixDigit = await createUser(SITE, {
    name: 'Test Six Digit',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: '419573',
    isActive: true,
  })
  check('a six-digit PIN is accepted', sixDigit.ok, sixDigit.ok ? '' : sixDigit.error)
  if (sixDigit.ok) created.push(sixDigit.id)

  // ── Sign-in ────────────────────────────────────────────────────────────
  console.log('')
  const good = await signInWithPin(SITE, '4827')
  check('the right PIN signs the right person in', good.ok && good.user.id === pos.id)

  const wrong = await signInWithPin(SITE, '9999')
  check('an unknown PIN is refused', !wrong.ok)

  const six = await signInWithPin(SITE, '419573')
  check('a six-digit PIN signs in', six.ok && six.user.name === 'Test Six Digit')

  // An inactive user must not be able to open a till.
  await updateUser(SITE, pos.id, {
    name: 'Test Cashier',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: null,
    isActive: false,
  })
  const inactive = await signInWithPin(SITE, '4827')
  check('an inactive user cannot sign in', !inactive.ok)

  // ...and their PIN is then free for someone else, since uniqueness only
  // constrains active users.
  const reuse = await createUser(SITE, {
    name: 'Test Reuse',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: '4827',
    isActive: true,
  })
  check("an inactive user's PIN can be reused", reuse.ok, reuse.ok ? '' : reuse.error)
  if (reuse.ok) created.push(reuse.id)

  // A POS-only user must not be left with no way in at all.
  const stripped = await clearPin(SITE, reuse.ok ? reuse.id : 0)
  check('a POS-only user cannot have their PIN cleared', !stripped.ok, stripped.error)

  const noPin = await createUser(SITE, {
    name: 'Test No PIN',
    email: null,
    userType: 'pos_only',
    roleId: cashier!.id,
    salesRepId: null,
    pin: null,
    isActive: true,
  })
  check('a POS-only user cannot be created without a PIN', !noPin.ok)
  if (noPin.ok) created.push(noPin.id)

  const noEmail = await createUser(SITE, {
    name: 'Test No Email',
    email: null,
    userType: 'back_office',
    roleId: cashier!.id,
    salesRepId: null,
    pin: '5926',
    isActive: true,
  })
  check('a back-office user cannot be created without an email', !noEmail.ok)
  if (noEmail.ok) created.push(noEmail.id)

  const all = await listUsers(SITE)
  check('listUsers returns the created users', all.some((u) => u.id === pos.id))
}

/** Removes everything the run created, whether it passed or threw. */
async function cleanup() {
  console.log('\ncleaning up...')
  for (const id of created) {
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [id]).catch(() => {})
  }
  for (const id of createdRoles) await deleteRole(SITE, id).catch(() => {})
  console.log(`removed ${created.length} user(s), ${createdRoles.length} role(s)`)
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

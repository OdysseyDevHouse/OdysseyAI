/**
 * Customer groups — the CRUD that had no caller until the setup screen landed.
 *
 * The two facts this suite exists to pin down are the ones a person editing a
 * group has to be able to trust:
 *
 *   THE DEFAULTS ARE A STARTING POINT. Changing a group's terms must NOT
 *   restate accounts that already exist — 012 says so in as many words, and an
 *   account agreed to what it agreed to.
 *
 *   THE PRICE STRUCTURE IS LIVE. It resolves through the group at the till on
 *   every sale, so changing it DOES move existing accounts.
 *
 * Also covers the write path that was silently missing: the interest and
 * statement-cycle defaults existed as columns since 037 and 065 and were read
 * everywhere, but neither create nor update wrote them, so they could never
 * leave their column defaults.
 *
 *   npm run test:customer-groups
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
  getCustomerGroup,
  listCustomerGroups,
  validateGroup,
} from '../src/lib/site/customerLookups'
import { createCustomer, getCustomer, updateCustomer } from '../src/lib/site/customers'
import { getTillCustomer } from '../src/lib/site/tillCustomers'

const SITE = 1
const actor = { userId: 1, userName: 'Group Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* ── Validation ───────────────────────────────────────────────────────── */

  ok('a group needs a name', validateGroup({ name: '  ' }) !== null)
  ok('a negative credit limit is refused', validateGroup({ name: 'X', defaultCreditLimit: -1 }) !== null)
  ok('terms beyond a year are refused', validateGroup({ name: 'X', defaultTermsDays: 400 }) !== null)
  ok(
    'an interest rate typed as basis points is refused',
    validateGroup({ name: 'X', defaultInterestRatePct: 1550 }) !== null,
  )
  ok('a cut day above 31 is refused', validateGroup({ name: 'X', defaultStatementAnchorDay: 32 }) !== null)
  ok(
    'a negative daily limit is refused',
    validateGroup({ name: 'X', defaultDailyLimit: -1 }) !== null,
  )
  ok(
    'a daily limit above the monthly one is refused',
    validateGroup({ name: 'X', defaultDailyLimit: 9_000, defaultMonthlyLimit: 5_000 }) !== null,
  )
  ok(
    'a discount above 100 is refused',
    validateGroup({ name: 'X', defaultDiscountPct: 101 }) !== null,
  )
  ok(
    'a null discount is fine — it means the group grants none',
    validateGroup({ name: 'X', defaultDiscountPct: null }) === null,
  )
  ok('a sane group validates', validateGroup({ name: 'Wholesale', defaultTermsDays: 30 }) === null)

  /* ── Create ───────────────────────────────────────────────────────────── */

  const structure = await siteQueryOne<any>(
    SITE,
    'SELECT id FROM price_structures WHERE is_active = 1 ORDER BY position LIMIT 1',
  )
  if (!structure) {
    console.log('**FAIL** no price structures on this site')
    process.exit(1)
  }

  /*
   * A second structure, created here rather than found.
   *
   * The live-repricing assertion below is the whole point of the price-structure
   * half of a group, and a site with one structure would SKIP it — leaving the
   * most consequential behaviour on this screen unproven on exactly the fresh
   * install where a regression is most likely. Cleaned up at the end.
   */
  const madeStructure = await siteExecute(
    SITE,
    'INSERT INTO price_structures (name, position, is_active, is_default) VALUES (?,?,1,0)',
    [`Trade ${stamp}`, 90],
  )
  const structure2 = { id: madeStructure.insertId }

  const created = await createCustomerGroup(SITE, {
    name: `Wholesale ${stamp}`,
    code: `WHL${stamp}`.slice(0, 32),
    defaultTermsDays: 60,
    defaultCreditLimit: 25_000,
    defaultDailyLimit: 2_000,
    defaultMonthlyLimit: 20_000,
    defaultDiscountPct: 7.5,
    defaultInterestRatePct: 15.5,
    defaultInterestEnabled: true,
    defaultInterestGraceDays: 7,
    defaultStatementCycle: '14day',
    defaultStatementAnchorDay: 0,
    priceStructureId: structure ? Number(structure.id) : null,
    sortOrder: 10,
  })
  ok('*** a group is created ***', created.ok, created.ok ? '' : created.error)
  if (!created.ok) process.exit(1)

  const group = await getCustomerGroup(SITE, created.id)
  ok('  terms persisted', group?.defaultTermsDays === 60, String(group?.defaultTermsDays))
  ok('  credit limit persisted', group?.defaultCreditLimit === 25_000, String(group?.defaultCreditLimit))
  ok('  daily limit persisted', group?.defaultDailyLimit === 2_000, String(group?.defaultDailyLimit))
  ok(
    '  monthly limit persisted',
    group?.defaultMonthlyLimit === 20_000,
    String(group?.defaultMonthlyLimit),
  )
  ok('  discount persisted', group?.defaultDiscountPct === 7.5, String(group?.defaultDiscountPct))

  // The columns that had no write path before this screen. Each of these would
  // have silently stayed at its column default.
  ok(
    '*** the interest rate is actually written ***',
    group?.defaultInterestRatePct === 15.5,
    `expected 15.5, got ${group?.defaultInterestRatePct}`,
  )
  ok('  interest enabled is written', group?.defaultInterestEnabled === true)
  ok('  the grace period is written', group?.defaultInterestGraceDays === 7, String(group?.defaultInterestGraceDays))
  ok(
    '*** the statement cycle is actually written ***',
    group?.defaultStatementCycle === '14day',
    `expected 14day, got ${group?.defaultStatementCycle}`,
  )

  /* ── The name is unique ───────────────────────────────────────────────── */

  const clash = await createCustomerGroup(SITE, { name: `Wholesale ${stamp}` })
  ok('a duplicate name is refused', !clash.ok, clash.ok ? '' : clash.error)

  /* ── An account in the group ──────────────────────────────────────────── */

  const cust = await createCustomer(SITE, actor, {
    code: `GRP${stamp}`,
    name: 'Group Member Co',
    groupId: created.id,
    paymentTermsDays: 60,
    creditLimit: 25_000,
  })
  ok('an account joins the group', cust.ok, cust.ok ? '' : cust.error)
  if (!cust.ok) process.exit(1)

  const inGroup = await getCustomer(SITE, cust.id)
  ok('  and reads the group name back', inGroup?.groupName === `Wholesale ${stamp}`, String(inGroup?.groupName))

  const tillBefore = await getTillCustomer(SITE, cust.id)
  ok(
    '*** the till resolves the price structure THROUGH the group ***',
    tillBefore?.priceStructureId === Number(structure.id),
    `${tillBefore?.priceStructureId} vs group ${structure.id}`,
  )
  // The account set no discount of its own, so it follows the group's.
  ok(
    "*** and the standing discount THROUGH the group too ***",
    tillBefore?.discountPct === 7.5,
    `expected 7.5 from the group, got ${tillBefore?.discountPct}`,
  )

  /*
   * updateCustomer writes the WHOLE row, so every call below carries the full
   * account and not just the field under test. Omitting one does not leave it
   * alone — it resets it to its default, which is the form's contract (the
   * real form always posts every field) and the reason a partial save here
   * would silently wipe the terms this suite asserts on later.
   */
  const account = {
    code: `GRP${stamp}`,
    name: 'Group Member Co',
    groupId: created.id,
    paymentTermsDays: 60,
    creditLimit: 25_000,
  }

  // An account with its OWN discount is not overridden by the group's.
  const ownDiscount = await updateCustomer(SITE, actor, cust.id, {
    ...account,
    discountPct: 2.5,
  })
  ok('an account can set its own discount', ownDiscount.ok, ownDiscount.ok ? '' : ownDiscount.error)
  ok(
    '*** the account beats the group on discount ***',
    (await getTillCustomer(SITE, cust.id))?.discountPct === 2.5,
    String((await getTillCustomer(SITE, cust.id))?.discountPct),
  )

  // An explicit ZERO on the account is a decision — it must NOT fall through
  // to the group. This is the assertion that catches a `toNum()` shortcut.
  const zeroDiscount = await updateCustomer(SITE, actor, cust.id, {
    ...account,
    discountPct: 0,
  })
  ok('an account can set an explicit zero', zeroDiscount.ok, zeroDiscount.ok ? '' : zeroDiscount.error)
  ok(
    '*** an explicit 0 on the account does NOT fall back to the group ***',
    (await getTillCustomer(SITE, cust.id))?.discountPct === 0,
    `expected 0, got ${(await getTillCustomer(SITE, cust.id))?.discountPct} — null and zero were collapsed`,
  )

  // Back to blank, so the fallback assertions below run against a following account.
  await updateCustomer(SITE, actor, cust.id, { ...account, discountPct: null })
  ok(
    '  clearing it returns the account to the group discount',
    (await getTillCustomer(SITE, cust.id))?.discountPct === 7.5,
    String((await getTillCustomer(SITE, cust.id))?.discountPct),
  )

  /* ── Editing the group ────────────────────────────────────────────────── */

  const edited = await updateCustomerGroup(SITE, created.id, {
    name: `Wholesale ${stamp}`,
    defaultTermsDays: 90,
    defaultCreditLimit: 50_000,
    defaultDailyLimit: 9_000,
    defaultMonthlyLimit: 90_000,
    defaultDiscountPct: 12,
    defaultInterestEnabled: false,
    defaultStatementCycle: 'monthly',
    priceStructureId: Number(structure2.id),
  })
  ok('the group is edited', edited.ok, edited.ok ? '' : edited.error)

  const reread = await getCustomerGroup(SITE, created.id)
  ok('  new terms took', reread?.defaultTermsDays === 90, String(reread?.defaultTermsDays))
  ok('  interest switched off', reread?.defaultInterestEnabled === false)
  ok('  the cycle changed back to monthly', reread?.defaultStatementCycle === 'monthly')

  // The heart of it: defaults are a starting point, never a live restatement.
  const untouched = await getCustomer(SITE, cust.id)
  ok(
    '*** raising the group limit did NOT restate the existing account ***',
    untouched?.creditLimit === 25_000,
    `expected the account to keep 25000, got ${untouched?.creditLimit}`,
  )
  ok(
    '*** nor did it restate the terms ***',
    untouched?.paymentTermsDays === 60,
    `expected 60, got ${untouched?.paymentTermsDays}`,
  )
  // The spend caps are seeded like the credit limit, so they must not move
  // either — the account was created before the group had any.
  ok(
    '*** nor did it restate the spend limits ***',
    untouched?.dailyLimit === 0 && untouched?.monthlyLimit === 0,
    `expected the account to keep 0/0, got ${untouched?.dailyLimit}/${untouched?.monthlyLimit}`,
  )

  // ...but the price structure IS live, and moves with the group. The mirror
  // image of the two assertions above, on the same account in the same breath —
  // which is what makes the distinction legible rather than asserted.
  const tillAfter = await getTillCustomer(SITE, cust.id)
  ok(
    '*** the price structure DID move with the group ***',
    tillAfter?.priceStructureId === Number(structure2.id),
    `${tillAfter?.priceStructureId} vs new ${structure2.id}`,
  )
  ok(
    '*** and so DID the standing discount ***',
    tillAfter?.discountPct === 12,
    `expected 12 from the edited group, got ${tillAfter?.discountPct}`,
  )

  // Clearing the group's discount returns its accounts to none — the null must
  // survive the round trip rather than being stored as 0.000.
  await updateCustomerGroup(SITE, created.id, {
    name: `Wholesale ${stamp}`,
    defaultDiscountPct: null,
    priceStructureId: Number(structure2.id),
  })
  ok(
    'clearing the group discount stores null, not zero',
    (await getCustomerGroup(SITE, created.id))?.defaultDiscountPct === null,
    String((await getCustomerGroup(SITE, created.id))?.defaultDiscountPct),
  )
  ok(
    '  and its accounts fall back to no discount',
    (await getTillCustomer(SITE, cust.id))?.discountPct === 0,
    String((await getTillCustomer(SITE, cust.id))?.discountPct),
  )

  /* ── Delete is refused while accounts point at it ─────────────────────── */

  const refused = await deleteCustomerGroup(SITE, created.id)
  ok(
    '*** a group still in use cannot be deleted ***',
    !refused.ok,
    refused.ok ? 'IT WAS DELETED — every account on it was silently unassigned' : refused.error,
  )
  ok(
    '  and the refusal says how many accounts',
    !refused.ok && refused.error.includes('1 customer'),
    refused.ok ? '' : refused.error,
  )

  const stillThere = await getCustomer(SITE, cust.id)
  ok('  the account kept its group', stillThere?.groupId === created.id, String(stillThere?.groupId))

  /* ── Deactivating is the way out ──────────────────────────────────────── */

  await updateCustomerGroup(SITE, created.id, { name: `Wholesale ${stamp}`, isActive: false })
  const active = await listCustomerGroups(SITE)
  const all = await listCustomerGroups(SITE, true)
  ok(
    'an inactive group drops out of the picker',
    !active.some((g) => g.id === created.id),
    `${active.length} active`,
  )
  ok(
    '  but the setup screen still sees it',
    all.some((g) => g.id === created.id),
    `${all.length} total`,
  )

  /* ── Delete works once nothing points at it ───────────────────────────── */

  await siteExecute(SITE, 'UPDATE customers SET group_id = NULL WHERE id = ?', [cust.id])
  const deleted = await deleteCustomerGroup(SITE, created.id)
  ok('*** an empty group deletes ***', deleted.ok, deleted.ok ? '' : deleted.error)
  ok('  and is gone', (await getCustomerGroup(SITE, created.id)) === null)

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  await siteExecute(SITE, 'DELETE FROM activity_log WHERE entity = ? AND entity_id = ?', ['customer', cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_groups WHERE name LIKE ?', [`Wholesale ${stamp}%`])
  // Last: the group above points at it, and the FK would otherwise refuse.
  await siteExecute(SITE, 'DELETE FROM price_structures WHERE id = ?', [structure2.id])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

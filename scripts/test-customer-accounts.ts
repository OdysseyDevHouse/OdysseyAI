/**
 * Customer accounts on the storefront, against a live site database.
 *
 * This is the only feature where an anonymous request can create a DEBT, so
 * the checks are mostly adversarial. Each corresponds to something a hostile
 * or careless request could otherwise achieve:
 *
 *   signing in as somebody by guessing passwords;
 *   learning which of a shop's customers have accounts;
 *   charging an order to an account you are not signed in to;
 *   spending past a credit limit, or on an account that is on hold;
 *   having a shop that does not offer accounts take one anyway.
 *
 *   npm run test:customer-accounts
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  accountCanCover,
  customerAccount,
  customerOrders,
  getCustomerLogin,
  setCustomerLogin,
  setCustomerLoginActive,
  signInCustomer,
  changeCustomerPassword,
} from '../src/lib/site/customerAuth'
import {
  getOnlineSettings,
  saveOnlineSettings,
  setDepartmentVisibility,
  listDepartmentVisibility,
  type OnlineSettingsInput,
} from '../src/lib/site/onlineStore'
import { placePublicOrder, publishedProducts, storefrontContext } from '../src/lib/site/storefront'

const SITE = 1
const TAG = '__TEST_ACCOUNT_CUSTOMER__'
const EMAIL = 'test-account-customer@example.invalid'
const PASSWORD = 'correct-horse-battery'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function cleanup() {
  const rows = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM customers WHERE name = ?`,
    [TAG],
  )
  for (const c of rows) {
    const orders = await siteQuery<{ id: number }>(
      SITE,
      `SELECT id FROM online_orders WHERE customer_id = ?`,
      [c.id],
    )
    for (const o of orders) {
      await siteExecute(SITE, `DELETE FROM online_order_lines WHERE order_id = ?`, [o.id])
    }
    await siteExecute(SITE, `DELETE FROM online_orders WHERE customer_id = ?`, [c.id])
    await siteExecute(SITE, `DELETE FROM customer_logins WHERE customer_id = ?`, [c.id])
  }
  await siteExecute(SITE, `DELETE FROM customers WHERE name = ?`, [TAG])
}

async function main() {
  await cleanup()

  const original = await getOnlineSettings(SITE)
  const { updatedAt: _a, updatedBy: _b, ...base } = original
  const deptsOn = (await listDepartmentVisibility(SITE)).filter((d) => d.showOnline).map((d) => d.id)

  /* ── A customer with an account ────────────────────────────────────────── */
  await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type, email, credit_limit, balance,
                            payment_terms_days)
     VALUES (?, ?, 'active', 'open_item', ?, 1000, 0, 30)`,
    [`TSTACC${Date.now() % 100000}`, TAG, EMAIL],
  )
  const customer = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1`,
    [TAG],
  )
  if (!customer) throw new Error('Could not create the test customer.')
  const customerId = customer.id

  /* ── Signing in ───────────────────────────────────────────────────────── */
  console.log('\n— Signing in —')
  ok(
    'no login means no sign-in',
    !(await signInCustomer(SITE, EMAIL, PASSWORD)).ok,
  )

  const created = await setCustomerLogin(SITE, customerId, EMAIL, PASSWORD)
  ok('staff can set up access', created.ok, created.ok ? '' : created.error)
  ok('a short password is refused', !(await setCustomerLogin(SITE, customerId, EMAIL, 'short')).ok)

  const good = await signInCustomer(SITE, EMAIL, PASSWORD)
  ok('the right password signs in', good.ok, good.ok ? '' : good.error)
  ok(
    'and it must be changed, because staff chose it',
    good.ok && good.identity.mustChange,
  )
  ok('the email is matched case-insensitively', (await signInCustomer(SITE, EMAIL.toUpperCase(), PASSWORD)).ok)

  const bad = await signInCustomer(SITE, EMAIL, 'wrong-password')
  const unknown = await signInCustomer(SITE, 'nobody@example.invalid', 'wrong-password')
  ok('a wrong password is refused', !bad.ok)
  ok('an unknown email is refused', !unknown.ok)
  /*
   * The one that matters. If these differed, the form would tell an attacker
   * which of the shop's customers have online accounts — and that is the list
   * worth attacking.
   */
  ok(
    'and BOTH give the identical message',
    !bad.ok && !unknown.ok && bad.error === unknown.error,
    !bad.ok && !unknown.ok ? `"${bad.error}"` : '',
  )

  /* ── Lockout ──────────────────────────────────────────────────────────── */
  console.log('\n— Lockout —')
  for (let i = 0; i < 8; i++) await signInCustomer(SITE, EMAIL, 'wrong-password')
  const locked = await signInCustomer(SITE, EMAIL, PASSWORD)
  ok('too many wrong passwords locks the login', !locked.ok)
  ok(
    'and says so, because the email is already known to exist',
    !locked.ok && /try again/i.test(locked.error),
    !locked.ok ? locked.error : '',
  )
  // A staff reset must clear the lock, or a customer who locked themselves out
  // stays locked out even after being given a new password.
  await setCustomerLogin(SITE, customerId, EMAIL, PASSWORD)
  ok('a staff reset unlocks it', (await signInCustomer(SITE, EMAIL, PASSWORD)).ok)

  /* ── Changing the password ────────────────────────────────────────────── */
  console.log('\n— Changing the password —')
  ok(
    'the current password is required',
    !(await changeCustomerPassword(SITE, customerId, 'not-it', 'a-new-password')).ok,
  )
  const changed = await changeCustomerPassword(SITE, customerId, PASSWORD, 'a-new-password')
  ok('the right one works', changed.ok, changed.ok ? '' : changed.error)
  ok('the old password stops working', !(await signInCustomer(SITE, EMAIL, PASSWORD)).ok)
  const afterChange = await signInCustomer(SITE, EMAIL, 'a-new-password')
  ok('the new one works', afterChange.ok)
  ok(
    'and the must-change prompt is gone',
    afterChange.ok && !afterChange.identity.mustChange,
  )

  /* ── Withdrawn access ─────────────────────────────────────────────────── */
  console.log('\n— Withdrawing access —')
  await setCustomerLoginActive(SITE, customerId, false)
  const withdrawn = await signInCustomer(SITE, EMAIL, 'a-new-password')
  ok('a withdrawn login cannot sign in', !withdrawn.ok)
  ok(
    'and is indistinguishable from a wrong password',
    !withdrawn.ok && !bad.ok && withdrawn.error === bad.error,
  )
  await setCustomerLoginActive(SITE, customerId, true)
  ok('restoring it works', (await signInCustomer(SITE, EMAIL, 'a-new-password')).ok)

  /* ── Credit ───────────────────────────────────────────────────────────── */
  console.log('\n— Credit —')
  const account = await customerAccount(SITE, customerId)
  ok('the account resolves', account !== null)
  ok('with the credit left on it', account?.availableCredit === 1000, `${account?.availableCredit}`)
  ok('and it is open', account?.accountOpen === true)
  ok('an affordable order is allowed', accountCanCover(account, 500).ok)
  ok('an order over the limit is refused', !accountCanCover(account, 1500).ok)
  ok(
    'exactly the limit is allowed, not lost to rounding',
    accountCanCover(account, 1000).ok,
  )
  // Not signed in at all must fail CLOSED rather than fall through.
  ok('no account at all is refused', !accountCanCover(null, 1).ok)

  await siteExecute(SITE, `UPDATE customers SET status = 'on_hold' WHERE id = ?`, [customerId])
  const held = await customerAccount(SITE, customerId)
  ok('an account on hold is not open', held?.accountOpen === false)
  ok('and cannot take an order of any size', !accountCanCover(held, 1).ok)
  await siteExecute(SITE, `UPDATE customers SET status = 'active' WHERE id = ?`, [customerId])

  // Zero limit means NO CREDIT GRANTED, not unlimited. This is the rule the
  // till and sales posting use, and the storefront must not disagree.
  await siteExecute(SITE, `UPDATE customers SET credit_limit = 0 WHERE id = ?`, [customerId])
  ok(
    'a zero limit means no credit, not unlimited',
    !accountCanCover(await customerAccount(SITE, customerId), 1).ok,
  )
  await siteExecute(SITE, `UPDATE customers SET credit_limit = 1000 WHERE id = ?`, [customerId])

  /* ── Ordering on account ──────────────────────────────────────────────── */
  console.log('\n— Ordering on account —')
  /*
   * A top-level department that actually HAS sellable products — the same fix
   * test-storefront.ts needed, and for the same reason.
   *
   * "The first one with no parent" picked whichever sorted first, which on
   * 2026-08-13 was an import-test fixture holding ZERO products. publishMode
   * 'departments' counts products in published departments rather than the flags
   * themselves, so saveOnlineSettings correctly refused to open an empty shop and
   * this suite died on its own fixture with "The shop did not open."
   */
  const departments = await listDepartmentVisibility(SITE)
  const stocked = await siteQuery<any>(
    SITE,
    `SELECT department_id AS id, COUNT(*) AS n FROM products
      WHERE is_archived = 0 AND department_id IS NOT NULL
      GROUP BY department_id ORDER BY n DESC`,
  )
  const stockedIds = new Set(stocked.map((r: any) => Number(r.id)))
  const parent =
    departments.find((d) => d.parentId === null && stockedIds.has(d.id)) ??
    departments.find((d) => d.parentId === null)
  if (!parent) throw new Error('Need a department to publish.')
  await setDepartmentVisibility(SITE, parent.id, true)

  const open: OnlineSettingsInput = {
    ...base,
    isEnabled: true,
    publishMode: 'departments',
    collectEnabled: true,
    deliverEnabled: false,
    minOrderIncl: 0,
    allowAccount: true,
  }
  await saveOnlineSettings(SITE, open, 'test')

  const context = await storefrontContext(SITE)
  if (!context) throw new Error('The shop did not open.')
  /*
   * The cheapest IN-STOCK product, from a wide enough sample to find one.
   *
   * `limit: 5` then cheapest-of-those picked whatever happened to sort first and
   * ignored stock entirely, so the order was refused with "has just sold out" — an
   * accurate message about a fixture, not a bug. placePublicOrder checks
   * availability, so the test has to as well.
   */
  const catalogue = await publishedProducts(context, { limit: 50 })
  if (catalogue.length === 0) throw new Error('Nothing published to order.')
  const sellable = catalogue.filter((p) => p.inStock)
  if (sellable.length === 0) throw new Error('Nothing published is in stock to order.')
  const cheap = [...sellable].sort((a, b) => a.priceIncl - b.priceIncl)[0]

  const shopper = { contactName: TAG, contactPhone: '0820000000', contactEmail: '' }
  const onAccount = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    lines: [{ productId: cheap.id, qty: 1 }],
    customerId,
    payOnAccount: true,
  })
  ok('an account order is accepted', onAccount.ok, onAccount.ok ? '' : onAccount.error)
  ok('and the server says it is on account', onAccount.ok && onAccount.onAccount === true)

  if (onAccount.ok) {
    const stored = await siteQueryOne<Record<string, unknown>>(
      SITE,
      `SELECT customer_id, pay_on_account FROM online_orders WHERE id = ?`,
      [onAccount.orderId],
    )
    ok('the customer is recorded on the order', Number(stored?.customer_id) === customerId)
    ok('and so is the account flag', Number(stored?.pay_on_account) === 1)

    // Placing the order must NOT move the balance. The debit happens when
    // staff accept it and the invoice is written, like any other sale.
    const balance = await siteQueryOne<{ balance: number }>(
      SITE,
      `SELECT balance FROM customers WHERE id = ?`,
      [customerId],
    )
    ok('placing the order moves NO money', Number(balance?.balance) === 0, `${balance?.balance}`)
  }

  /* ── The adversarial ones ─────────────────────────────────────────────── */
  console.log('\n— A shopper cannot charge an account they are not signed in to —')
  const noSession = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    lines: [{ productId: cheap.id, qty: 1 }],
    // Exactly what a crafted request would carry: the flag but no session.
    customerId: null,
    payOnAccount: true,
  })
  ok('no signed-in customer means no account order', !noSession.ok)

  const tooBig = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    // 9999 of anything is past a R1000 limit.
    lines: [{ productId: cheap.id, qty: 999 }],
    customerId,
    payOnAccount: true,
  })
  ok('an order past the credit limit is refused', !tooBig.ok, tooBig.ok ? '' : tooBig.error)

  await siteExecute(SITE, `UPDATE customers SET status = 'on_hold' WHERE id = ?`, [customerId])
  const whileHeld = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    lines: [{ productId: cheap.id, qty: 1 }],
    customerId,
    payOnAccount: true,
  })
  ok('an account on hold cannot order on account', !whileHeld.ok)
  await siteExecute(SITE, `UPDATE customers SET status = 'active' WHERE id = ?`, [customerId])

  // A shop that does not offer accounts must not take one however the request
  // arrived — the setting is the gate, not the absence of a checkbox.
  await saveOnlineSettings(SITE, { ...open, allowAccount: false }, 'test')
  const notOffered = await placePublicOrder(SITE, {
    ...shopper,
    fulfilment: 'collect',
    lines: [{ productId: cheap.id, qty: 1 }],
    customerId,
    payOnAccount: true,
  })
  ok('a shop with accounts off refuses one', !notOffered.ok, notOffered.ok ? '' : notOffered.error)
  await saveOnlineSettings(SITE, open, 'test')

  /* ── The customer's own view ──────────────────────────────────────────── */
  console.log('\n— A customer sees only their own orders —')
  const mine = await customerOrders(SITE, customerId)
  ok('their order is listed', mine.length >= 1, `${mine.length}`)
  ok('and it is marked as on account', mine.some((o) => o.onAccount))

  const other = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM customers WHERE name <> ? AND status = 'active' ORDER BY id LIMIT 1`,
    [TAG],
  )
  if (other) {
    const theirs = await customerOrders(SITE, other.id)
    ok(
      'another customer does not see it',
      !theirs.some((o) => mine.some((m) => m.id === o.id)),
    )
  }

  const summary = await getCustomerLogin(SITE, customerId)
  ok('staff can see the login exists', summary?.email === EMAIL)
  ok('and it records the last sign-in', summary?.lastLoginAt !== null)

  /* ── Restore ──────────────────────────────────────────────────────────── */
  console.log('\n— Cleanup —')
  await cleanup()
  await saveOnlineSettings(SITE, base, 'test')
  for (const d of await listDepartmentVisibility(SITE)) {
    if (d.showOnline !== deptsOn.includes(d.id)) {
      await setDepartmentVisibility(SITE, d.id, deptsOn.includes(d.id))
    }
  }
  const left = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM customers WHERE name = ?`,
    [TAG],
  )
  ok('the test customer is gone', Number(left?.n) === 0)
  ok('settings restored', (await getOnlineSettings(SITE)).isEnabled === original.isEnabled)

  console.log(`\n${fails === 0 ? 'All customer account checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

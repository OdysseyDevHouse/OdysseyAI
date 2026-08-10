/**
 * Discount codes — validation, and the lock that stops one being spent twice.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-discount-codes.ts
 *
 * The assertions that matter:
 *
 *   · A SINGLE-USE CODE SURVIVES A RACE. Two shoppers redeeming the last use in
 *     the same instant both pass validation — they each read uses_count = 0 —
 *     and the FOR UPDATE lock is what makes exactly one of them win. This is
 *     THE test in this file; without it a shop honours a code twice.
 *   · A discount never exceeds the goods it applies to, or the order total goes
 *     negative and the till has to explain it.
 *   · Specials do not stack unless the shop says so, and when they do not, the
 *     reduced lines are EXCLUDED rather than the whole code refused.
 *   · Per-customer limits work for GUESTS, who are most shoppers here.
 *   · An unknown code and an inactive one give the SAME message, so the field
 *     cannot be used to discover which campaigns exist.
 *   · Dates, minimums and first-order-only all refuse with a reason a shopper
 *     can act on.
 */
import { siteExecute, siteQuery, siteTransaction } from '../src/lib/siteDb'
import {
  validateCode,
  redeemCode,
  saveCode,
  normaliseCode,
  type DiscountBasketLine,
} from '../src/lib/site/discountCodes'

const SITE = 1
const TAG = 'ZZTEST'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A plain two-line basket: 2 × R100 and 1 × R50 = R250. */
function basket(overrides: Partial<DiscountBasketLine>[] = []): DiscountBasketLine[] {
  const base: DiscountBasketLine[] = [
    { productId: 1, qty: 2, unitPriceIncl: 100, onSpecial: false, departmentId: 9 },
    { productId: 2, qty: 1, unitPriceIncl: 50, onSpecial: false, departmentId: 10 },
  ]
  return base.map((line, i) => ({ ...line, ...(overrides[i] ?? {}) }))
}

async function makeCode(code: string, input: Partial<Parameters<typeof saveCode>[2]> = {}) {
  const result = await saveCode(
    SITE,
    null,
    {
      code,
      description: 'test',
      kind: 'percent',
      value: 10,
      minOrderIncl: 0,
      startsAt: null,
      endsAt: null,
      maxUses: null,
      maxUsesPerCustomer: null,
      firstOrderOnly: false,
      departmentId: null,
      combinesWithSpecials: false,
      isActive: true,
      ...input,
    },
    'test',
  )
  if (!result.ok) throw new Error(`could not create ${code}: ${result.error}`)
  return result.id
}

async function cleanup() {
  await siteExecute(
    SITE,
    `DELETE FROM discount_code_uses WHERE code_id IN
       (SELECT id FROM discount_codes WHERE code LIKE '${TAG}%')`,
  )
  await siteExecute(SITE, `DELETE FROM discount_codes WHERE code LIKE '${TAG}%'`)
}

async function main() {
  await cleanup()

  /* ── 1. Normalising ──────────────────────────────────────────────────── */

  ok('a code is normalised to uppercase', normaliseCode('  save10 ') === 'SAVE10')

  /* ── 2. Percent and amount ───────────────────────────────────────────── */

  await makeCode(`${TAG}PCT`, { kind: 'percent', value: 10 })
  let r = await validateCode(SITE, `${TAG.toLowerCase()}pct`, { lines: basket() })
  ok('a percentage code applies, case-insensitively', r.ok)
  ok(
    '  10% of R250 is R25',
    r.ok && Math.abs(r.application.discountIncl - 25) < 0.005,
    r.ok ? String(r.application.discountIncl) : r.error,
  )

  await makeCode(`${TAG}AMT`, { kind: 'amount', value: 40 })
  r = await validateCode(SITE, `${TAG}AMT`, { lines: basket() })
  ok('a flat-amount code applies', r.ok && Math.abs(r.application.discountIncl - 40) < 0.005)

  /* ── 3. Never more than the goods ────────────────────────────────────── */

  await makeCode(`${TAG}BIG`, { kind: 'amount', value: 9999 })
  r = await validateCode(SITE, `${TAG}BIG`, { lines: basket() })
  ok(
    'a discount is capped at the goods total',
    r.ok && Math.abs(r.application.discountIncl - 250) < 0.005,
    r.ok ? String(r.application.discountIncl) : r.error,
  )

  /* ── 4. Unknown and inactive read the same ───────────────────────────── */

  const unknown = await validateCode(SITE, `${TAG}NOPE`, { lines: basket() })
  await makeCode(`${TAG}OFF`, { isActive: false })
  const inactive = await validateCode(SITE, `${TAG}OFF`, { lines: basket() })
  ok('an unknown code is refused', !unknown.ok)
  ok('an inactive code is refused', !inactive.ok)
  ok(
    '  and the two messages are IDENTICAL, so the field reveals nothing',
    !unknown.ok && !inactive.ok && unknown.error === inactive.error,
    !unknown.ok && !inactive.ok ? `${unknown.error} / ${inactive.error}` : '',
  )

  /* ── 5. Dates ────────────────────────────────────────────────────────── */

  await makeCode(`${TAG}FUTURE`, { startsAt: '2099-01-01 00:00:00' })
  r = await validateCode(SITE, `${TAG}FUTURE`, { lines: basket() })
  ok('a code that has not started is refused', !r.ok, r.ok ? '' : r.error)

  await makeCode(`${TAG}PAST`, { endsAt: '2000-01-01 00:00:00' })
  r = await validateCode(SITE, `${TAG}PAST`, { lines: basket() })
  ok('an expired code is refused', !r.ok, r.ok ? '' : r.error)

  // asAt is threaded, so "was it valid then" is answerable.
  r = await validateCode(SITE, `${TAG}PAST`, { lines: basket() }, new Date('1999-06-01'))
  ok('  but it WAS valid back when it ran', r.ok)

  /* ── 6. Minimum order ────────────────────────────────────────────────── */

  await makeCode(`${TAG}MIN`, { minOrderIncl: 500 })
  r = await validateCode(SITE, `${TAG}MIN`, { lines: basket() })
  ok('a code below its minimum is refused', !r.ok, r.ok ? '' : r.error)

  /* ── 7. Specials do not stack unless allowed ─────────────────────────── */

  const onSpecial = basket([{ onSpecial: true }])
  await makeCode(`${TAG}NOSTACK`, { kind: 'percent', value: 10, combinesWithSpecials: false })
  r = await validateCode(SITE, `${TAG}NOSTACK`, { lines: onSpecial })
  ok(
    'a non-stacking code EXCLUDES the special line rather than refusing',
    r.ok && Math.abs(r.application.discountIncl - 5) < 0.005,
    r.ok ? String(r.application.discountIncl) : r.error,
  )

  await makeCode(`${TAG}STACK`, { kind: 'percent', value: 10, combinesWithSpecials: true })
  r = await validateCode(SITE, `${TAG}STACK`, { lines: onSpecial })
  ok(
    'a stacking code discounts everything',
    r.ok && Math.abs(r.application.discountIncl - 25) < 0.005,
    r.ok ? String(r.application.discountIncl) : r.error,
  )

  // Everything on special, non-stacking: nothing left to discount.
  r = await validateCode(SITE, `${TAG}NOSTACK`, {
    lines: basket([{ onSpecial: true }, { onSpecial: true }]),
  })
  ok('a non-stacking code with nothing eligible is refused', !r.ok, r.ok ? '' : r.error)

  /* ── 8. Department scope ─────────────────────────────────────────────── */

  await makeCode(`${TAG}DEPT`, { kind: 'percent', value: 50, departmentId: 10 })
  r = await validateCode(SITE, `${TAG}DEPT`, { lines: basket() })
  ok(
    'a department code only discounts its own department',
    r.ok && Math.abs(r.application.discountIncl - 25) < 0.005,
    r.ok ? String(r.application.discountIncl) : r.error,
  )

  /* ── 9. Free delivery ────────────────────────────────────────────────── */

  await makeCode(`${TAG}SHIP`, { kind: 'free_delivery', value: 0 })
  r = await validateCode(SITE, `${TAG}SHIP`, { lines: basket(), deliveryFeeIncl: 35 })
  ok('a free-delivery code waives the fee', r.ok && r.application.freeDelivery)
  ok('  and takes nothing off the goods', r.ok && r.application.discountIncl === 0)

  /* ── 10. THE RACE ────────────────────────────────────────────────────── */

  const onceId = await makeCode(`${TAG}ONCE`, { maxUses: 1 })

  // Both validate first — exactly as two real checkouts would, each reading
  // uses_count = 0 before either has spent it.
  const a = await validateCode(SITE, `${TAG}ONCE`, { lines: basket() })
  const b = await validateCode(SITE, `${TAG}ONCE`, { lines: basket() })
  ok('two shoppers both pass validation on a single-use code', a.ok && b.ok)

  // Two orders to hang the redemptions off — the ledger has an FK to them.
  const orderIds = await makeTestOrders(2)

  const outcomes = await Promise.all([
    siteTransaction(SITE, (tx) =>
      redeemCode(tx, {
        codeId: onceId,
        orderId: orderIds[0],
        customerId: null,
        contactEmail: 'a@example.com',
        amountIncl: 25,
      }),
    ).catch(() => false),
    siteTransaction(SITE, (tx) =>
      redeemCode(tx, {
        codeId: onceId,
        orderId: orderIds[1],
        customerId: null,
        contactEmail: 'b@example.com',
        amountIncl: 25,
      }),
    ).catch(() => false),
  ])

  const winners = outcomes.filter(Boolean).length
  ok(
    '*** EXACTLY ONE of two concurrent redemptions wins ***',
    winners === 1,
    `${winners} won`,
  )

  const [counter] = await siteQuery<{ uses_count: number }>(
    SITE,
    'SELECT uses_count FROM discount_codes WHERE id = ?',
    [onceId],
  )
  ok('  and the counter is exactly 1', Number(counter?.uses_count) === 1, String(counter?.uses_count))

  const ledger = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM discount_code_uses WHERE code_id = ?',
    [onceId],
  )
  ok('  with one ledger row to match', Number(ledger[0]?.n) === 1, String(ledger[0]?.n))

  // And it is now exhausted for everybody.
  r = await validateCode(SITE, `${TAG}ONCE`, { lines: basket() })
  ok('  the code is then fully used', !r.ok, r.ok ? '' : r.error)

  /* ── 11. Per-customer limit, for a GUEST ─────────────────────────────── */

  const guestId = await makeCode(`${TAG}GUEST`, { maxUsesPerCustomer: 1 })
  const guestOrders = await makeTestOrders(1)
  await siteTransaction(SITE, (tx) =>
    redeemCode(tx, {
      codeId: guestId,
      orderId: guestOrders[0],
      customerId: null,
      contactEmail: 'repeat@example.com',
      amountIncl: 25,
    }),
  )

  r = await validateCode(SITE, `${TAG}GUEST`, {
    lines: basket(),
    contactEmail: 'REPEAT@example.com',
  })
  ok('a guest cannot reuse a once-per-customer code', !r.ok, r.ok ? '' : r.error)

  r = await validateCode(SITE, `${TAG}GUEST`, {
    lines: basket(),
    contactEmail: 'someone-else@example.com',
  })
  ok('  but a different shopper still can', r.ok)

  /* ── 12. Bad input is refused at the editor ──────────────────────────── */

  const bad = await saveCode(
    SITE,
    null,
    {
      code: `${TAG}BAD`,
      description: '',
      kind: 'percent',
      value: 150,
      minOrderIncl: 0,
      startsAt: null,
      endsAt: null,
      maxUses: null,
      maxUsesPerCustomer: null,
      firstOrderOnly: false,
      departmentId: null,
      combinesWithSpecials: false,
      isActive: true,
    },
    'test',
  )
  ok('a percentage over 100 is refused', !bad.ok, bad.ok ? '' : bad.error)

  const dup = await saveCode(
    SITE,
    null,
    {
      code: `${TAG}PCT`,
      description: '',
      kind: 'percent',
      value: 5,
      minOrderIncl: 0,
      startsAt: null,
      endsAt: null,
      maxUses: null,
      maxUsesPerCustomer: null,
      firstOrderOnly: false,
      departmentId: null,
      combinesWithSpecials: false,
      isActive: true,
    },
    'test',
  )
  ok('a duplicate code is refused by name', !dup.ok, dup.ok ? '' : dup.error)

  /* ── Clean up ────────────────────────────────────────────────────────── */
  await siteExecute(SITE, `DELETE FROM online_orders WHERE order_number LIKE '${TAG}%'`)
  await cleanup()
  const left = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM discount_codes WHERE code LIKE '${TAG}%'`,
  )
  ok('the test leaves nothing behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll discount checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

/** Minimal orders, purely so the ledger's foreign key has something to point at. */
async function makeTestOrders(count: number): Promise<number[]> {
  const [status] = await siteQuery<{ id: number }>(
    SITE,
    "SELECT id FROM online_order_statuses WHERE role = 'new' LIMIT 1",
  )
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const number = `${TAG}-${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}`
    await siteExecute(
      SITE,
      `INSERT INTO online_orders (order_number, status_id, fulfilment, contact_name, total_incl)
       VALUES (?,?,'collect','Race Test',0)`,
      [number, status.id],
    )
    const [row] = await siteQuery<{ id: number }>(
      SITE,
      'SELECT id FROM online_orders WHERE order_number = ?',
      [number],
    )
    ids.push(Number(row.id))
  }
  return ids
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

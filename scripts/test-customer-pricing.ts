/**
 * Per-customer pricing — the resolver, the cap, and the basket default.
 *
 * The rules that matter:
 *
 *   CUSTOMER BEATS GROUP BEATS SITE. Resolved ONCE, on the TillCustomer,
 *   because every attach flow receives one — a second resolver drifts.
 *
 *   THE CAP IS AT APPLICATION TIME. checkPricing refuses a line above the
 *   product's ceiling for anyone without the override right; an uncapped
 *   account discount would brick a cashier's till from a back-office form.
 *
 *   NULL IS NOT ZERO. No standing discount and an explicit 0 are different
 *   facts and both must survive a round trip.
 *
 *   npm run test:customer-pricing
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer, updateCustomer, getCustomer } from '../src/lib/site/customers'
import { getTillCustomer } from '../src/lib/site/tillCustomers'
import { accountDiscountFor, addToBasket } from '../src/lib/basket'
import type { TillProduct } from '../src/lib/site/tillSearch'

const SITE = 1
const actor = { userId: 1, userName: 'Pricing Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-8)

function fakeProduct(overrides: Partial<TillProduct> = {}): TillProduct {
  return {
    id: 1,
    code: 'X',
    barcode: null,
    barcodes: [],
    description: 'Test product',
    productType: 'normal',
    departmentId: null,
    priceIncl: 100,
    vatRatePct: 15,
    costExcl: 50,
    stockOnHand: 10,
    reservedQty: 0,
    availableQty: 10,
    askPriceAtSale: false,
    allowFractions: false,
    scaleItem: false,
    variableType: 'none',
    maxDiscountPct: 0,
    imageColor: null,
    imageIcon: null,
    posSortOrder: 0,
    // An ordinary product: in no variant group and standing for nothing. A
    // parent could not be priced here anyway — it never becomes a line.
    hasVariants: false,
    parentId: null,
    axis1Value: '',
    axis2Value: '',
    variantSort: 0,
    ...overrides,
  }
}

async function main() {
  // ── The pure cap
  ok('no ceiling means the full discount', accountDiscountFor(fakeProduct(), 12.5) === 12.5)
  ok('*** the ceiling caps the account discount ***',
    accountDiscountFor(fakeProduct({ maxDiscountPct: 10 }), 25) === 10)
  ok('zero stays zero', accountDiscountFor(fakeProduct({ maxDiscountPct: 10 }), 0) === 0)
  ok('a negative is clamped to zero', accountDiscountFor(fakeProduct(), -5) === 0)

  // ── The basket default and its merge rule
  const withDiscount = addToBasket([], fakeProduct(), 1, 100, 7.5)
  ok('*** the standing discount rides the line ***', withDiscount[0].discountPct === 7.5)
  const merged = addToBasket(withDiscount, fakeProduct(), 1, 100, 7.5)
  ok('*** identical standing discounts merge ***', merged.length === 1 && merged[0].qty === 2,
    JSON.stringify(merged.map((l) => `${l.qty}@${l.discountPct}`)))
  const walkIn = addToBasket(withDiscount, fakeProduct(), 1, 100, 0)
  ok('  a walk-in add does NOT merge into a discounted line', walkIn.length === 2)

  // ── The resolver, against real rows
  const structure = await siteQueryOne<any>(SITE,
    'SELECT id FROM price_structures WHERE is_active = 1 ORDER BY position LIMIT 1')
  const structure2 = await siteQueryOne<any>(SITE,
    'SELECT id FROM price_structures WHERE is_active = 1 ORDER BY position LIMIT 1 OFFSET 1')
  if (!structure) { console.log('**FAIL** no price structures on this site'); process.exit(1) }

  const groupRes = await siteExecute(SITE,
    'INSERT INTO customer_groups (name, price_structure_id) VALUES (?, ?)',
    [`PRCG${stamp}`, structure.id])
  const groupId = groupRes.insertId

  const cust = await createCustomer(SITE, actor, {
    code: `PRC${stamp}`, name: 'Pricing Test Co', paymentTermsDays: 30, creditLimit: 0,
    groupId, discountPct: 5,
  })
  if (!cust.ok) { console.log('**FAIL** customer'); process.exit(1) }

  let till = await getTillCustomer(SITE, cust.id)
  ok('*** no own structure falls back to the GROUP ***',
    till?.priceStructureId === Number(structure.id),
    `${till?.priceStructureId} vs group ${structure.id}`)
  ok('  the standing discount rides the till customer', till?.discountPct === 5)

  if (structure2) {
    const updated = await updateCustomer(SITE, actor, cust.id, {
      code: `PRC${stamp}`, name: 'Pricing Test Co', paymentTermsDays: 30, creditLimit: 0,
      groupId, priceStructureId: Number(structure2.id), discountPct: 5,
    })
    ok('an own structure saves', updated.ok)
    till = await getTillCustomer(SITE, cust.id)
    ok('*** the customer beats the group ***', till?.priceStructureId === Number(structure2.id),
      `${till?.priceStructureId} vs own ${structure2.id}`)
  } else {
    console.log('SKIP  only one price structure on this site — customer-beats-group not exercised')
  }

  // ── Null vs zero survives the round trip
  const cleared = await updateCustomer(SITE, actor, cust.id, {
    code: `PRC${stamp}`, name: 'Pricing Test Co', paymentTermsDays: 30, creditLimit: 0,
    groupId, priceStructureId: null, discountPct: null,
  })
  ok('clearing both saves', cleared.ok)
  const read = await getCustomer(SITE, cust.id)
  ok('*** null discount reads back null, not zero ***', read?.discountPct === null,
    String(read?.discountPct))
  const backToGroup = await getTillCustomer(SITE, cust.id)
  ok('  and the structure falls back to the group again',
    backToGroup?.priceStructureId === Number(structure.id))

  ok('a discount above 100 is refused',
    !(await updateCustomer(SITE, actor, cust.id, {
      code: `PRC${stamp}`, name: 'Pricing Test Co', paymentTermsDays: 30, creditLimit: 0,
      discountPct: 120,
    })).ok)

  // ── Cleanup
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_groups WHERE id = ?', [groupId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await siteExecute(SITE, "DELETE FROM customers WHERE code LIKE 'PRC%'").catch(() => {})
  await siteExecute(SITE, "DELETE FROM customer_groups WHERE name LIKE 'PRCG%'").catch(() => {})
  console.log('\nCRASHED — swept')
  process.exit(1)
})

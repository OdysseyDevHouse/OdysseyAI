/**
 * Supplier price lists — what they AGREED to charge, and from when.
 *
 * THE RULE: the price on a date is the latest row whose effective_from is not
 * in the future. That is what lets a list for 1 March be keyed in February and
 * start working on the day it said it would.
 *
 * Everything reads AS AT a date rather than "now", for the same reason billing
 * does: an order raised last week was raised at last week's prices, and a
 * screen opened today must not silently reprice it.
 *
 *   npm run test:supplier-prices
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  priceFor,
  pricesFor,
  listSupplierPrices,
  saveSupplierPrice,
  saveSupplierPriceList,
  deleteSupplierPrice,
  validatePrice,
  priceVariances,
} from '../src/lib/site/supplierPrices'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Price Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const present = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='supplier_prices' LIMIT 1`,
  )
  if (!present) {
    console.log('\nSKIP — 093_supplier_price_lists.sql has not reached this site.')
    process.exit(0)
  }

  console.log('\n── Validation ──')

  const base = {
    supplierId: 1,
    productId: 1,
    effectiveFrom: '2026-03-01',
    costExcl: 10,
  }
  ok('a sound line passes', validatePrice(base) === null)
  ok('a missing supplier is refused', validatePrice({ ...base, supplierId: 0 }) !== null)
  ok('a missing product is refused', validatePrice({ ...base, productId: 0 }) !== null)
  ok('a malformed date is refused', validatePrice({ ...base, effectiveFrom: 'March' }) !== null)
  ok('a negative cost is refused', validatePrice({ ...base, costExcl: -1 }) !== null)
  ok('a zero pack is refused', validatePrice({ ...base, packSize: 0 }) !== null)
  ok('a zero cost is allowed — a freebie is a real agreement', validatePrice({ ...base, costExcl: 0 }) === null)

  // ── Fixtures
  const supA = await createSupplier(SITE, actor, {
    code: `PRA${stamp}`,
    name: 'Price Test Wholesalers',
    paymentTermsDays: 30,
  })
  const supB = await createSupplier(SITE, actor, {
    code: `PRB${stamp}`,
    name: 'Price Test Alternatives',
    paymentTermsDays: 30,
  })
  if (!supA.ok || !supB.ok) {
    console.log('setup failed')
    process.exit(1)
  }

  const mk = async (suffix: string, lastCost = 99) =>
    (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,'normal',0,?,?,1)`,
        [`PR${suffix}${stamp}`, `Price test ${suffix}`, lastCost, lastCost],
      )
    ).insertId

  const p1 = await mk('A')

  console.log('\n── THE EFFECTIVE-DATE RULE ──')

  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p1,
    effectiveFrom: '2026-01-01',
    costExcl: 10,
    listReference: 'JAN-LIST',
  })
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p1,
    effectiveFrom: '2026-03-01',
    costExcl: 12,
    listReference: 'MAR-LIST',
  })
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p1,
    effectiveFrom: '2027-01-01',
    costExcl: 20,
    listReference: 'NEXT-YEAR',
  })

  ok(
    '*** in February, January’s price applies ***',
    (await priceFor(SITE, supA.id, p1, '2026-02-15'))?.costExcl === 10,
    String((await priceFor(SITE, supA.id, p1, '2026-02-15'))?.costExcl),
  )
  ok(
    '*** on the day it starts, March’s does ***',
    (await priceFor(SITE, supA.id, p1, '2026-03-01'))?.costExcl === 12,
    String((await priceFor(SITE, supA.id, p1, '2026-03-01'))?.costExcl),
  )
  ok(
    '  and the day before, it does not',
    (await priceFor(SITE, supA.id, p1, '2026-02-28'))?.costExcl === 10,
  )
  ok(
    '*** A FUTURE LIST IS IGNORED until its date ***',
    (await priceFor(SITE, supA.id, p1, '2026-06-01'))?.costExcl === 12,
    `${(await priceFor(SITE, supA.id, p1, '2026-06-01'))?.costExcl} (20 would mean next year is already live)`,
  )
  ok(
    '  but applies once reached',
    (await priceFor(SITE, supA.id, p1, '2027-02-01'))?.costExcl === 20,
  )
  ok(
    '*** before ANY list, there is no agreed price ***',
    (await priceFor(SITE, supA.id, p1, '2025-01-01')) === null,
  )
  ok(
    '  the reference comes with it',
    (await priceFor(SITE, supA.id, p1, '2026-04-01'))?.listReference === 'MAR-LIST',
  )

  console.log('\n── Two suppliers, two prices ──')

  await saveSupplierPrice(SITE, {
    supplierId: supB.id,
    productId: p1,
    effectiveFrom: '2026-01-01',
    costExcl: 8.5,
  })
  ok(
    '*** the same product from another supplier is another price ***',
    (await priceFor(SITE, supB.id, p1, '2026-04-01'))?.costExcl === 8.5,
    String((await priceFor(SITE, supB.id, p1, '2026-04-01'))?.costExcl),
  )
  ok(
    "  and the first supplier's is unchanged",
    (await priceFor(SITE, supA.id, p1, '2026-04-01'))?.costExcl === 12,
  )

  console.log('\n── Many at once ──')

  const p2 = await mk('B')
  const p3 = await mk('C')
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p2,
    effectiveFrom: '2026-01-01',
    costExcl: 5,
  })
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p2,
    effectiveFrom: '2026-03-01',
    costExcl: 7,
  })

  const many = await pricesFor(SITE, supA.id, [p1, p2, p3], '2026-04-01')
  ok('*** each product gets ITS OWN latest row ***', many.get(p1)?.costExcl === 12 && many.get(p2)?.costExcl === 7,
    `p1 ${many.get(p1)?.costExcl}, p2 ${many.get(p2)?.costExcl}`)
  ok('*** a product never quoted is simply absent ***', !many.has(p3))
  ok('an empty list asks nothing of the database', (await pricesFor(SITE, supA.id, [])).size === 0)

  // The greatest-n-per-group trap: a naive GROUP BY gives the right DATE with
  // the wrong COST, and it is silent.
  const feb = await pricesFor(SITE, supA.id, [p1, p2], '2026-02-01')
  ok(
    '*** and as at a past date, the older prices ***',
    feb.get(p1)?.costExcl === 10 && feb.get(p2)?.costExcl === 5,
    `p1 ${feb.get(p1)?.costExcl}, p2 ${feb.get(p2)?.costExcl}`,
  )

  console.log('\n── Correcting a list line ──')

  const before = await listSupplierPrices(SITE, { supplierId: supA.id, productId: p1 })
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p1,
    effectiveFrom: '2026-03-01',
    costExcl: 13,
  })
  const after = await listSupplierPrices(SITE, { supplierId: supA.id, productId: p1 })
  ok(
    '*** re-keying the same date CORRECTS rather than stacking ***',
    after.total === before.total,
    `${before.total} -> ${after.total}`,
  )
  ok(
    '  and the new figure applies',
    (await priceFor(SITE, supA.id, p1, '2026-04-01'))?.costExcl === 13,
  )

  console.log('\n── The list screen ──')

  const listed = await listSupplierPrices(SITE, { supplierId: supA.id })
  ok('every row comes back, superseded and future included', listed.total >= 4, String(listed.total))
  const current = listed.items.filter((i) => i.isCurrent)
  ok(
    '*** exactly one row per product is marked current ***',
    current.length === new Set(current.map((c) => c.productId)).size,
    JSON.stringify(current.map((c) => [c.productCode, c.effectiveFrom, c.costExcl])),
  )
  ok(
    "*** a future row is NOT marked current ***",
    !listed.items.some((i) => i.effectiveFrom === '2027-01-01' && i.isCurrent),
  )

  const onlyCurrent = await listSupplierPrices(SITE, { supplierId: supA.id, currentOnly: true })
  ok(
    'currentOnly hides superseded and future rows',
    onlyCurrent.items.every((i) => i.isCurrent || i.effectiveFrom <= new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)),
    String(onlyCurrent.total),
  )

  console.log('\n── A whole list at once ──')

  const bulk = await saveSupplierPriceList(SITE, [
    { supplierId: supA.id, productId: p3, effectiveFrom: '2026-05-01', costExcl: 4 },
    { supplierId: supA.id, productId: 999999999, effectiveFrom: '2026-05-01', costExcl: 4 },
    { supplierId: supA.id, productId: p2, effectiveFrom: '2026-05-01', costExcl: 9 },
  ])
  ok('*** the good lines load ***', bulk.saved === 2, String(bulk.saved))
  ok('*** and the bad one is REPORTED, not silently dropped ***', bulk.errors.length === 1)
  ok('  naming which line it was', bulk.errors[0]?.index === 1, JSON.stringify(bulk.errors))

  console.log('\n── Variance against what was actually invoiced ──')

  const p4 = await mk('D')
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p4,
    effectiveFrom: '2020-01-01',
    costExcl: 100,
  })

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)

  const grv = await receiveGoods(SITE, actor, {
    supplierId: supA.id,
    lines: [
      // Agreed 100, invoiced 115. This is the case the feature exists for.
      { productId: p4, description: 'Price test D', qtyReceived: 10, unitCostExcl: 115, vatRatePct: rate },
    ],
  })
  ok('a receipt at the wrong price still posts', grv.ok, grv.ok ? '' : (grv as any).error)
  if (grv.ok) {
    const variances = await priceVariances(SITE, grv.documentId)
    ok(
      '*** the overcharge is found ***',
      variances.length === 1 && variances[0].variance === 15,
      JSON.stringify(variances),
    )
    ok('  showing both figures', variances[0]?.agreed === 100 && variances[0]?.paid === 115)
  }

  const p5 = await mk('E')
  await saveSupplierPrice(SITE, {
    supplierId: supA.id,
    productId: p5,
    effectiveFrom: '2020-01-01',
    costExcl: 50,
  })
  const honest = await receiveGoods(SITE, actor, {
    supplierId: supA.id,
    lines: [
      { productId: p5, description: 'Price test E', qtyReceived: 10, unitCostExcl: 50, vatRatePct: rate },
    ],
  })
  if (honest.ok) {
    ok(
      '*** a receipt AT the agreed price reports nothing ***',
      (await priceVariances(SITE, honest.documentId)).length === 0,
    )
  }

  console.log('\n── Deleting ──')

  const doomed = await saveSupplierPrice(SITE, {
    supplierId: supB.id,
    productId: p3,
    effectiveFrom: '2026-09-01',
    costExcl: 1,
  })
  ok('a price saves', doomed.ok)
  if (doomed.ok) {
    ok('*** it can be deleted ***', (await deleteSupplierPrice(SITE, doomed.id)).ok)
    ok('  and is gone', !(await deleteSupplierPrice(SITE, doomed.id)).ok)
  }

  console.log('\n── Refusals ──')

  ok(
    'an unknown product is refused',
    !(await saveSupplierPrice(SITE, {
      supplierId: supA.id,
      productId: 999999999,
      effectiveFrom: '2026-01-01',
      costExcl: 1,
    })).ok,
  )
  ok(
    'an unknown supplier is refused',
    !(await saveSupplierPrice(SITE, {
      supplierId: 999999999,
      productId: p1,
      effectiveFrom: '2026-01-01',
      costExcl: 1,
    })).ok,
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * Price and discount overrides — enforced, not merely hidden.
 *
 *   npm run test:price-guard
 *
 * `sales.price_override` and `sales.discount_override` were both enforced only
 * in the browser: the till greyed a box out, the invoice editor disabled a
 * cell, and the server accepted whatever number arrived. A capability that
 * lives in a `disabled` attribute is a suggestion.
 *
 * These checks call the guard directly with capability sets built by hand, so
 * they prove the rule rather than the UI that usually asks it.
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { checkPricing } from '../src/lib/site/priceGuard'
import type { CapabilitySet } from '../src/lib/site/permissions'

const SITE = 1
let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

/** A capability set holding exactly what is listed. */
function holding(...caps: string[]): CapabilitySet {
  return { isOwner: false, granted: new Set(caps) }
}

const OWNER: CapabilitySet = { isOwner: true, granted: new Set() }
const CASHIER = holding('sales.till')

let productId = 0
let structureId: number | null = null
let scheduleId = 0

async function main() {
  const structure = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM price_structures ORDER BY is_default DESC, id LIMIT 1',
  )
  structureId = structure?.id ?? null

  // A product with a known shelf price and a 10% discount ceiling, so every
  // assertion below has an exact figure behind it.
  const made = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, max_discount_pct, ask_price_at_sale)
     VALUES ('TESTPG1', 'Price guard test', 10.000, 0)`,
  )
  productId = made.insertId

  if (structureId) {
    await siteExecute(
      SITE,
      `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
       VALUES (?,?,100.0000)
       ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
      [productId, structureId],
    )
  }

  const line = (over: Partial<{ unitPriceIncl: number; discountPct: number }> = {}) => [
    {
      productId,
      description: 'Price guard test',
      unitPriceIncl: 100,
      discountPct: 0,
      ...over,
    },
  ]

  /* ── Price ─────────────────────────────────────────────────────────── */
  console.log('\nprice')

  check(
    'the shelf price is accepted without the capability',
    (await checkPricing(SITE, CASHIER, structureId, line())) === null,
  )

  const cut = await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 80 }))
  check('a LOWER price is refused without the capability', cut !== null, cut ?? '')

  const raised = await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 130 }))
  // Refused in both directions on purpose: overcharging a customer is a
  // different problem from discounting, but it is still not the shelf price.
  check('a HIGHER price is refused too', raised !== null, raised ?? '')

  check(
    'the capability permits a changed price',
    (await checkPricing(
      SITE,
      holding('sales.till', 'sales.price_override'),
      structureId,
      line({ unitPriceIncl: 80 }),
    )) === null,
  )

  check(
    'an owner is never refused',
    (await checkPricing(SITE, OWNER, structureId, line({ unitPriceIncl: 1 }))) === null,
  )

  check(
    'a cent of rounding is not an override',
    (await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 100.004 }))) === null,
  )

  /* ── Discount ──────────────────────────────────────────────────────── */
  console.log('\ndiscount')

  check(
    'a discount within the product limit is accepted',
    (await checkPricing(SITE, CASHIER, structureId, line({ discountPct: 10 }))) === null,
  )

  const over = await checkPricing(SITE, CASHIER, structureId, line({ discountPct: 25 }))
  check('a discount above the limit is refused', over !== null, over ?? '')

  check(
    'the capability permits exceeding the limit',
    (await checkPricing(
      SITE,
      holding('sales.till', 'sales.discount_override'),
      structureId,
      line({ discountPct: 90 }),
    )) === null,
  )

  /* ── Priced at the counter ─────────────────────────────────────────── */
  //
  // A product with no shelf price has nothing to depart FROM. Requiring a
  // supervisor to type its price would stop the till working for cut flowers,
  // fabric off a roll, or a repair quoted at the counter.
  console.log('\npriced at the counter')

  await siteExecute(SITE, 'UPDATE products SET ask_price_at_sale = 1 WHERE id = ?', [productId])
  check(
    'typing the price of an ask-at-sale product is not an override',
    (await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 250 }))) === null,
  )
  await siteExecute(SITE, 'UPDATE products SET ask_price_at_sale = 0 WHERE id = ?', [productId])

  /* ── Lines with no product ─────────────────────────────────────────── */
  console.log('\nfree-text lines')
  check(
    'a line with no product is not checked',
    (await checkPricing(SITE, CASHIER, structureId, [
      { productId: null, description: 'Delivery', unitPriceIncl: 500, discountPct: 0 },
    ])) === null,
  )

  /* ── The refusal names the item ────────────────────────────────────── */
  console.log('\nthe message')
  const message = await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 80 }))
  check(
    'the refusal names the product and the shelf price',
    !!message?.includes('Price guard test') && !!message?.includes('100.00'),
    message ?? '',
  )

  /* ── A scheduled price that has landed ─────────────────────────────── */
  //
  // THE CASE THAT WOULD STOP A SHOP TRADING.
  //
  // A till applies a six o'clock price change on its own clock; the cron writes
  // it to product_prices a few minutes later. In between, the till is charging
  // the new price and the table still holds the old one. If the guard only ever
  // trusted the table, every sale in that window would be refused for an
  // ordinary cashier — with customers standing there — and every offline sale
  // syncing from it would be flagged as an override.
  console.log('\na scheduled price that is due')

  if (structureId) {
    const made = await siteExecute(
      SITE,
      `INSERT INTO price_schedules (name, effective_at, status)
       VALUES ('ZZ Guard test', ?, 'armed')`,
      [momentIn(-5)],
    )
    scheduleId = made.insertId
    await siteExecute(
      SITE,
      `INSERT INTO price_schedule_lines
         (schedule_id, product_id, price_structure_id, new_price_incl, old_price_incl)
       VALUES (?,?,?,120.0000,100.0000)`,
      [scheduleId, productId, structureId],
    )

    check(
      'the DUE scheduled price is accepted without the capability',
      (await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 120 }))) === null,
    )

    // The old price is still the price the table holds, and a customer who was
    // quoted it before six is not an override either.
    check(
      'the price still on file is accepted as well',
      (await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 100 }))) === null,
    )

    const invented = await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 140 }))
    check('a price that is neither is still refused', invented !== null, invented ?? '')

    /* ── And one that has NOT arrived yet ───────────────────────────── */
    //
    // Next week's cheaper price is not a price anybody may ring up today.
    await siteExecute(SITE, 'UPDATE price_schedules SET effective_at = ? WHERE id = ?', [
      momentIn(60 * 24 * 7),
      scheduleId,
    ])

    const early = await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 120 }))
    check('a FUTURE scheduled price is refused', early !== null, early ?? '')

    check(
      'and the shelf price still works',
      (await checkPricing(SITE, CASHIER, structureId, line({ unitPriceIncl: 100 }))) === null,
    )
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Wall-clock text N minutes from now, in the format the column stores. */
function momentIn(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

async function cleanup() {
  console.log('\ncleaning up...')
  /* The schedule first: its lines point at the product, and a leftover armed
     row would be picked up by the next tick — which would then reprice a
     product this test has already deleted. */
  if (scheduleId) {
    await siteExecute(SITE, 'DELETE FROM price_schedules WHERE id = ?', [scheduleId]).catch(() => {})
  }
  if (productId) {
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
  }
  console.log('removed the test product')
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

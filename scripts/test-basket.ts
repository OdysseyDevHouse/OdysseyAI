/**
 * Basket rules — pure, no database.
 *
 *   npx tsx scripts/test-basket.ts
 *
 * These are the decisions a cashier feels: whether a second scan of the same
 * barcode becomes one line or two, what − does to the last unit, and whether a
 * discount is allowed. All of it is value-in value-out, so it runs with no
 * connection and lands in the fast parallel group of the suite.
 */
import {
  addToBasket,
  stepQty,
  updateBasketLine,
  removeBasketLine,
  discountAllowed,
  isPriceOverridden,
  basketCount,
  lineFromProduct,
  type BasketLine,
} from '../src/lib/basket'
import type { TillProduct } from '../src/lib/site/tillSearch'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A plain stocked product. Fields not under test get harmless values. */
const product = (over: Partial<TillProduct> = {}): TillProduct =>
  ({
    id: 1,
    code: 'COKE500',
    barcode: '6001240100015',
    description: 'Coca-Cola 500ml',
    productType: 'normal',
    departmentId: 3,
    priceIncl: 14.99,
    vatRatePct: 15,
    costExcl: 8,
    stockOnHand: 100,
    reservedQty: 0,
    availableQty: 100,
    askPriceAtSale: false,
    allowFractions: false,
    maxDiscountPct: 10,
    ...over,
  }) as TillProduct

function main() {
  /* ── Merging ─────────────────────────────────────────────────────────── */

  {
    let lines = addToBasket([], product())
    lines = addToBasket(lines, product())
    ok('the same product twice is ONE line of two', lines.length === 1 && lines[0].qty === 2)
  }

  {
    let lines = addToBasket([], product())
    lines = addToBasket(lines, product({ id: 2, code: 'MILK1L' }))
    ok('a different product is a second line', lines.length === 2)
  }

  {
    // A discounted line must not absorb the next scan, or that unit silently
    // takes a discount nobody applied to it.
    let lines = addToBasket([], product())
    lines = updateBasketLine(lines, lines[0].key, { discountPct: 10 })
    lines = addToBasket(lines, product())
    ok(
      'a DISCOUNTED line does not absorb the next scan',
      lines.length === 2 && lines[0].qty === 1 && lines[1].qty === 1,
    )
  }

  {
    // Priced at the counter: the second one may well be a different price, and
    // merging would charge the first one's.
    let lines = addToBasket([], product({ askPriceAtSale: true }))
    lines = addToBasket(lines, product({ askPriceAtSale: true }))
    ok('a counter-priced product never merges', lines.length === 2)
  }

  {
    // An overridden price was a decision about those units.
    let lines = addToBasket([], product())
    lines = updateBasketLine(lines, lines[0].key, { unitPriceIncl: 9.99 })
    lines = addToBasket(lines, product())
    ok('an OVERRIDDEN price does not absorb the next scan', lines.length === 2)
  }

  {
    // A variable-weight barcode carries its own money; two of them are two
    // different amounts and must never collapse into one line.
    let lines = addToBasket([], product({ scannedPrice: 43.21 }))
    lines = addToBasket(lines, product({ scannedPrice: 51.06 }))
    ok('two weighed items stay two lines', lines.length === 2)
  }

  /* ── Quantity stepping ───────────────────────────────────────────────── */

  {
    const lines = addToBasket([], product())
    const up = stepQty(lines, lines[0].key, 1)
    ok('+ steps to 2', up[0].qty === 2)
    const gone = stepQty(lines, lines[0].key, -1)
    ok('− on the last unit REMOVES the line', gone.length === 0)
  }

  {
    // Whole units only: a − on a 1kg line of tinned beans must not leave half a
    // tin, whatever step it is asked for.
    const lines = addToBasket([], product({ allowFractions: false }), 3)
    const stepped = stepQty(lines, lines[0].key, -0.5)
    ok('a non-fractional product steps by whole units', stepped[0].qty === 2, String(stepped[0].qty))
  }

  {
    const lines = addToBasket([], product({ allowFractions: true }), 1.5)
    const stepped = stepQty(lines, lines[0].key, 0.25)
    ok('a weighed product steps by the fraction asked', stepped[0].qty === 1.75, String(stepped[0].qty))
  }

  {
    // Repeated addition of thirds is where floating point drifts into
    // 2.9999999999999996 and a DECIMAL(_,3) column rounds it to something the
    // cashier did not type.
    let lines = addToBasket([], product({ allowFractions: true }), 0.1)
    for (let i = 0; i < 9; i++) lines = addToBasket(lines, product({ allowFractions: true }), 0.1)
    ok('ten additions of 0.1 make exactly 1', lines[0].qty === 1, String(lines[0].qty))
  }

  /* ── Discount ceiling ────────────────────────────────────────────────── */

  {
    const line = lineFromProduct(product({ maxDiscountPct: 10 }), 1, 0)
    ok('a discount at the ceiling is allowed', discountAllowed(line, 10))
    ok('a discount above the ceiling is refused', !discountAllowed(line, 10.5))
    ok('zero is always allowed', discountAllowed(line, 0))
    ok('a negative discount is refused', !discountAllowed(line, -5))
  }

  {
    // The reading that matters: 0 means "none allowed", not "unlimited". The
    // opposite would quietly let staff discount a protected line to nothing.
    const protectedLine = lineFromProduct(product({ maxDiscountPct: 0 }), 1, 0)
    ok('maxDiscountPct 0 means NO discount, not unlimited', !discountAllowed(protectedLine, 1))
  }

  /* ── Odds and ends ───────────────────────────────────────────────────── */

  {
    const lines = addToBasket([], product())
    ok('a fresh line is not overridden', !isPriceOverridden(lines[0]))
    const over = updateBasketLine(lines, lines[0].key, { unitPriceIncl: 12 })
    ok('a changed price reads as overridden', isPriceOverridden(over[0]))

    // No shelf figure to differ from, so nothing can be "off" it.
    const counter = addToBasket([], product({ askPriceAtSale: true }))
    ok('a counter-priced line is never "overridden"', !isPriceOverridden(counter[0]))
  }

  {
    let lines = addToBasket([], product(), 3)
    lines = addToBasket(lines, product({ id: 2 }), 2)
    ok('basketCount counts items, not lines', basketCount(lines) === 5, String(basketCount(lines)))
    lines = removeBasketLine(lines, lines[0].key)
    ok('removing a line drops its items', basketCount(lines) === 2)
  }

  {
    // Two scans in the same millisecond are ordinary with a scanner gun, and two
    // lines sharing a key makes React reuse the wrong row.
    const a = lineFromProduct(product({ askPriceAtSale: true }), 1, 0)
    const b = lineFromProduct(product({ askPriceAtSale: true }), 1, 1)
    ok('keys are unique within a basket', a.key !== b.key)
  }

  {
    const missing = stepQty([], 'nope', 1)
    ok('stepping a line that is not there changes nothing', missing.length === 0)
    const noop = updateBasketLine([], 'nope', { qty: 5 })
    ok('updating a line that is not there changes nothing', noop.length === 0)
  }

  console.log(fails === 0 ? '\nAll basket checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

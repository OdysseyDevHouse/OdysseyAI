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
  isRefundLine,
  basketCount,
  lineFromProduct,
  withRewards,
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

  /* ── A REFUND LINE ON AN ORDINARY SALE ────────────────────────────────────
     One item handed back mid-basket, stored as a NEGATIVE quantity on the same
     slip as the goods being bought. See `refundArmed` in the till's sale state
     for why it is a one-shot rather than a mode. These are the basket-level
     rules that make it safe. */

  {
    const sold = lineFromProduct(product(), 1, 0)
    const back = lineFromProduct(product(), -1, 1)
    ok('a negative line reads as a refund', isRefundLine(back))
    ok('  and a positive one does not', !isRefundLine(sold))
  }

  {
    /* THE one that would silently lose money. A −1 and a +1 of the same product
       folded together give a qty-0 line, which validateDocument refuses — so the
       whole sale dies at the tender, naming a line the cashier sees nothing wrong
       with. The customer's shirt would simply have vanished off the slip. */
    const back = lineFromProduct(product(), -1, 0)
    const after = addToBasket([back], product(), 1)
    ok(
      '*** a sale never merges into a refund line of the same product ***',
      after.length === 2,
      JSON.stringify(after.map((l) => l.qty)),
    )
    ok(
      '  so neither cancels the other out',
      after[0].qty === -1 && after[1].qty === 1,
      JSON.stringify(after.map((l) => l.qty)),
    )
  }

  {
    /* The chip a cashier checks a bag against. Netting read "0 items" on a
       one-in-one-out basket, which on a screen with two lines on it looks like an
       empty till. */
    const lines = [lineFromProduct(product(), 1, 0), lineFromProduct(product({ id: 2 }), -1, 1)]
    ok(
      'basketCount counts a refund as an item, not against one',
      basketCount(lines) === 2,
      String(basketCount(lines)),
    )
  }

  {
    /* The stepper works in the LINE's own direction, so + and − mean what the
       screen says they mean. Before this, − on a −1 line deleted it (next <= 0)
       and + on it deleted it too (next === 0) — the row was untouchable. */
    const back = [lineFromProduct(product(), -1, 0)]
    const more = stepQty(back, back[0].key, 1)
    ok(
      'stepping + on a refund line credits MORE of it',
      more[0]?.qty === -2,
      JSON.stringify(more.map((l) => l.qty)),
    )
    const fewer = stepQty(more, more[0].key, -1)
    ok('  and − walks it back toward zero', fewer[0]?.qty === -1, JSON.stringify(fewer.map((l) => l.qty)))
    const gone = stepQty(fewer, fewer[0].key, -1)
    ok('  and stepping the last one off removes the line', gone.length === 0)
  }

  {
    /* Unchanged for an ordinary line — the sign-aware branch must not have
       changed what − does to the last unit of something being sold. */
    const sold = addToBasket([], product(), 1)
    ok('− on the last unit of a sale still removes it', stepQty(sold, sold[0].key, -1).length === 0)
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

  /* ── Rewards a deal hands over ──────────────────────────────────────────
   *
   * The engine answers "what does this basket earn" from scratch on every
   * keystroke, so `withRewards` has to turn a repeated full answer into the
   * smallest set of changes. The two things that must hold: it never touches a
   * line the cashier owns, and an unchanged answer returns the SAME array —
   * because the till calls it from an effect, and a new array every time is an
   * infinite render loop.
   */
  {
    const bread = product({ id: 99, code: 'BREAD', description: 'Garlic bread' })
    const describe = (productId: number) =>
      productId === 99 ? lineFromProduct(bread, 1, 0) : null

    const pizza = lineFromProduct(product({ id: 1, description: 'Pizza' }), 2, 0)
    const basket = [pizza]

    const earned = withRewards(basket, [{ specialId: 7, productId: 99, qty: 1 }], describe)
    ok('an earned reward is added to the basket', earned.length === 2)
    ok('the reward is free', earned[1].unitPriceIncl === 0)
    ok('and it is NOT a discount', earned[1].discountPct === 0)
    ok('it remembers which special gave it', earned[1].rewardSpecialId === 7)
    ok('the goods that earned it are untouched', earned[0] === pizza)

    // The same answer again. This is the every-keystroke case.
    const again = withRewards(earned, [{ specialId: 7, productId: 99, qty: 1 }], describe)
    ok(
      '*** the same answer returns the SAME array ***',
      again === earned,
      'a new array here is an infinite render loop at the till',
    )

    const more = withRewards(earned, [{ specialId: 7, productId: 99, qty: 2 }], describe)
    ok('a changed quantity is applied', more[1].qty === 2)
    ok('and it is a new array, so the screen updates', more !== earned)
    ok('the reward keeps its key, so React does not remount it', more[1].key === earned[1].key)

    const lost = withRewards(earned, [], describe)
    ok('un-earning takes the reward back off', lost.length === 1)
    ok('and leaves the cashier-owned line alone', lost[0] === pizza)

    const unknown = withRewards(basket, [{ specialId: 7, productId: 404, qty: 1 }], describe)
    ok(
      'a reward naming an unknown product is simply not granted',
      unknown.length === 1,
      'better a deal that quietly does not pay than a blank line on a slip',
    )

    const nothing = withRewards(basket, [], describe)
    ok('no rewards and none granted returns the same array', nothing === basket)

    const zero = withRewards(basket, [{ specialId: 7, productId: 99, qty: 0 }], describe)
    ok('a zero-quantity reward grants nothing', zero.length === 1)
  }

  console.log(fails === 0 ? '\nAll basket checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

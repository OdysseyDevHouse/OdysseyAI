/**
 * Product properties that the SALE has to honour — pure, no database.
 *
 *   npm run test:product-properties
 *
 * Four switches on the Properties tab were being saved and never read. Three of
 * them had no consumer anywhere in the app, and the fourth was worse than that:
 * `ask_price_at_sale` told `checkPricing` to skip the override guard for the
 * product — because typing the price IS the normal path for one — while nothing
 * ever prompted for a price. So the flag switched the safety net off and left
 * the stored price on the line.
 *
 * These checks exercise the pure half of the fix: what a line looks like when it
 * is built from a product carrying each flag, and how a percentage charge
 * behaves as the rest of the basket moves. The prompting itself is a modal and
 * is checked in the browser.
 */
import { addToBasket, lineFromProduct, removeBasketLine, repriceCharges, updateBasketLine, type BasketLine } from '../src/lib/basket'
import { lineTotals } from '../src/lib/documentMath'
import type { TillProduct } from '../src/lib/site/tillSearch'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const product = (over: Partial<TillProduct> = {}): TillProduct =>
  ({
    id: 1,
    code: 'SUNDRY',
    barcode: null,
    barcodes: [],
    description: 'Sundry',
    productType: 'normal',
    departmentId: 1,
    priceIncl: 100,
    vatRatePct: 15,
    costExcl: 50,
    stockOnHand: 10,
    reservedQty: 0,
    availableQty: 10,
    askPriceAtSale: false,
    changeDescription: false,
    chargePctSubtotal: false,
    allowFractions: false,
    qtyDecimals: 3,
    scaleItem: false,
    variableType: 'none',
    maxDiscountPct: 0,
    imageColor: null,
    imageIcon: null,
    hasVariants: false,
    parentId: null,
    axis1Value: null,
    axis2Value: null,
    variantSort: 0,
    posSortOrder: 0,
    ...over,
  }) as TillProduct

console.log('\n── The flags reach the line ───────────────────────────────\n')

{
  const line = lineFromProduct(product({ changeDescription: true }), 1, 0)
  ok(
    'a "describe at the counter" product still opens with its stored wording',
    line.description === 'Sundry',
    line.description,
  )
}

{
  /*
   * The till hands the typed price in on `scannedPrice`, which is the channel
   * every add path already honours — the same mechanism a variable-price
   * barcode uses. This is what the modal's confirm does.
   */
  const typed = product({ askPriceAtSale: true, scannedPrice: 250 })
  const line = lineFromProduct(typed, 1, 0)
  ok('a typed price becomes the line price', line.unitPriceIncl === 250, String(line.unitPriceIncl))
  ok(
    'and the line records no shelf price to be judged against',
    line.shelfPriceIncl === null,
    String(line.shelfPriceIncl),
  )
}

{
  /*
   * A priced-at-sale line must never merge into an existing one: two repairs at
   * two different quoted prices are two lines, and merging them would silently
   * charge the second at the first one's figure.
   */
  const asked = product({ askPriceAtSale: true, scannedPrice: 250 })
  const one = addToBasket([], asked, 1)
  const two = addToBasket(one, { ...asked, scannedPrice: 400 }, 1)
  ok('two priced-at-sale items stay two lines', two.length === 2, `${two.length} lines`)
}

console.log('\n── A percentage charge is derived, not typed ──────────────\n')

{
  /*
   * The stored figure is the RATE. Putting it straight on the line would charge
   * R10 the instant the charge was added, which is the bug this pair of fields
   * exists to prevent.
   */
  const service = product({ id: 9, code: 'SERV', description: 'Service charge', chargePctSubtotal: true, priceIncl: 10 })
  const line = lineFromProduct(service, 1, 0)
  ok('it opens at no money', line.unitPriceIncl === 0, String(line.unitPriceIncl))
  ok('and carries the rate instead', line.chargePct === 10, String(line.chargePct))
}

{
  const goods = lineFromProduct(product({ priceIncl: 200 }), 1, 0)
  const service = lineFromProduct(
    product({ id: 9, code: 'SERV', description: 'Service', chargePctSubtotal: true, priceIncl: 10 }),
    1,
    1,
  )

  const priced = repriceCharges([goods, service])
  ok(
    '10% of a R200 bill is R20',
    priced[1].unitPriceIncl === 20,
    String(priced[1].unitPriceIncl),
  )

  // The charge follows the basket: another R200 of goods doubles it.
  const more = repriceCharges([...priced, lineFromProduct(product({ priceIncl: 200 }), 1, 2)])
  const charge = more.find((l) => l.chargePctSubtotal)!
  ok('adding goods moves the charge with them', charge.unitPriceIncl === 40, String(charge.unitPriceIncl))

  // And back down again when they are taken off.
  const fewer = repriceCharges(removeBasketLine(more, more[2].key))
  ok(
    'removing them moves it back',
    fewer.find((l) => l.chargePctSubtotal)!.unitPriceIncl === 20,
    String(fewer.find((l) => l.chargePctSubtotal)!.unitPriceIncl),
  )
}

{
  /*
   * THE BASE IS NET OF DISCOUNT. A service charge on a discounted bill is taken
   * on what the customer actually pays — charging on the gross would quietly
   * claw back part of the discount.
   */
  const goods = updateBasketLine(
    [lineFromProduct(product({ priceIncl: 200 }), 1, 0)],
    lineFromProduct(product({ priceIncl: 200 }), 1, 0).key,
    { discountPct: 50 },
  )
  const service = lineFromProduct(
    product({ id: 9, code: 'SERV', description: 'Service', chargePctSubtotal: true, priceIncl: 10 }),
    1,
    1,
  )
  const priced = repriceCharges([...goods, service])
  ok(
    'the charge is taken after discount, not before',
    priced[1].unitPriceIncl === 10,
    `${priced[1].unitPriceIncl} (R200 less 50% = R100, 10% of that)`,
  )
}

{
  /*
   * TWO CHARGES DO NOT COMPOUND. If each one charged on the other, the total
   * would depend on the order the lines were rung — indefensible on a receipt.
   */
  const goods = lineFromProduct(product({ priceIncl: 200 }), 1, 0)
  const service = lineFromProduct(
    product({ id: 9, code: 'SERV', description: 'Service', chargePctSubtotal: true, priceIncl: 10 }),
    1,
    1,
  )
  const card = lineFromProduct(
    product({ id: 10, code: 'CARD', description: 'Card fee', chargePctSubtotal: true, priceIncl: 5 }),
    1,
    2,
  )

  const forwards = repriceCharges([goods, service, card])
  const backwards = repriceCharges([goods, card, service])

  ok(
    'each charge is taken on the goods alone',
    forwards[1].unitPriceIncl === 20 && forwards[2].unitPriceIncl === 10,
    `${forwards[1].unitPriceIncl} and ${forwards[2].unitPriceIncl}`,
  )

  const total = (ls: BasketLine[]) =>
    ls.reduce((sum, l) => sum + lineTotals({ qty: l.qty, unitPriceIncl: l.unitPriceIncl, discountPct: l.discountPct, vatRatePct: l.vatRatePct }).lineTotalIncl, 0)

  ok(
    'so the bill totals the same whichever was rung first',
    total(forwards) === total(backwards),
    `${total(forwards)} vs ${total(backwards)}`,
  )
}

{
  // A basket with no charge on it must come back as the very same array, or the
  // till re-renders on every keystroke for nothing.
  const plain = [lineFromProduct(product(), 1, 0)]
  ok('an ordinary basket is returned untouched', repriceCharges(plain) === plain)
}

console.log('\n── Both switches on one product ──────────────────────────\n')

{
  /*
   * "Ask for the price" and "charge % of subtotal" contradict each other, and a
   * product can carry both. The typed figure is read as the RATE — as money it
   * would be overwritten by the very next reprice, so that reading is the only
   * one under which typing anything changes the outcome.
   *
   * This is the case that reported "I typed 12 and it added as zero": the typed
   * figure was discarded as a price and the rate was read from the product's
   * stored price instead, which was nothing.
   */
  const both = product({
    id: 9,
    code: 'SERV',
    description: 'Service charge',
    chargePctSubtotal: true,
    askPriceAtSale: true,
    priceIncl: 0,
    scannedPrice: 12,
  })

  const line = lineFromProduct(both, 1, 0)
  ok('a typed 12 becomes a 12% rate, not R12', line.chargePct === 12, String(line.chargePct))
  ok('and the line still opens at no money', line.unitPriceIncl === 0, String(line.unitPriceIncl))

  const goods = lineFromProduct(product({ priceIncl: 200 }), 1, 1)
  const priced = repriceCharges([goods, line])
  ok(
    'so it charges 12% of the R200 bill',
    priced[1].unitPriceIncl === 24,
    String(priced[1].unitPriceIncl),
  )
}

console.log(fails === 0 ? '\nAll product-property checks passed.\n' : `\n${fails} FAILED\n`)
process.exit(fails === 0 ? 0 : 1)

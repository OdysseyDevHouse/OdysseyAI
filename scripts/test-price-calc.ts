/**
 * products.price_calc — what a COST change does to a selling price.
 *
 * The setting was stored, editable and importable for a long time without a
 * single line of pricing code reading it, so both halves of it were wrong in
 * daily trade: a "Markup Fixed" product silently drifted off its markup on
 * every delivery, and a "Selling Price Fixed" product moved its price when
 * somebody typed in the markup box.
 */
import { repricedForCostChange, markupPercent, removeVat } from '../src/lib/pricing'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The markup a product is actually on, given what it costs and sells for. */
const markupOf = (costExcl: number, sellIncl: number, vat: number) =>
  markupPercent(costExcl, removeVat(sellIncl, vat))

function main() {
  // ── Markup Fixed: the markup survives, the price moves ─────────────────
  // The customer's own example: a 20% product whose cost changes is still a
  // 20% product.
  const twentyPct = repricedForCostChange({
    priceCalc: 'markup',
    oldCostExcl: 100,
    newCostExcl: 120,
    currentSellIncl: 138, // 100 +20% = 120 excl, +15% VAT
    sellingVatPercent: 15,
  })
  ok('markup fixed: cost 100->120 moves price 138->165.60', twentyPct === 165.6, String(twentyPct))
  ok(
    'markup fixed: the product is STILL on 20%',
    markupOf(120, twentyPct!, 15) === 20,
    String(markupOf(120, twentyPct!, 15)),
  )

  // A cost DROP has to move the price down just as readily. A rule that only
  // ratchets upward quietly turns every supplier discount into extra margin.
  const cheaper = repricedForCostChange({
    priceCalc: 'markup',
    oldCostExcl: 100,
    newCostExcl: 80,
    currentSellIncl: 138,
    sellingVatPercent: 15,
  })
  ok('markup fixed: a cost DROP lowers the price', cheaper === 110.4, String(cheaper))
  ok('markup fixed: still 20% after the drop', markupOf(80, cheaper!, 15) === 20)

  // The markup is read off the tier being repriced, not off one shared figure.
  // Retail at 20% and wholesale at 8% must each keep their OWN markup.
  const retail = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 100, newCostExcl: 120,
    currentSellIncl: 138, sellingVatPercent: 15,
  })
  const wholesale = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 100, newCostExcl: 120,
    currentSellIncl: 124.2, // 100 +8%
    sellingVatPercent: 15,
  })
  ok('markup fixed: retail tier holds 20%', markupOf(120, retail!, 15) === 20)
  ok('markup fixed: wholesale tier holds its OWN 8%', markupOf(120, wholesale!, 15) === 8,
    String(markupOf(120, wholesale!, 15)))
  ok('markup fixed: the two tiers did NOT collapse onto one price', retail !== wholesale)

  // Zero-rated stock has no VAT leg; the rule must not assume 15%.
  const zeroRated = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 50, newCostExcl: 60,
    currentSellIncl: 60, sellingVatPercent: 0,
  })
  ok('markup fixed: zero-rated holds 20%', zeroRated === 72, String(zeroRated))

  // ── Selling Price Fixed: the price survives, the margin gives ──────────
  const held = repricedForCostChange({
    priceCalc: 'selling',
    oldCostExcl: 100,
    newCostExcl: 120,
    currentSellIncl: 138,
    sellingVatPercent: 15,
  })
  ok('selling fixed: cost change does NOT move the price', held === null, String(held))

  // Null is the whole contract: it means "leave the stored price alone". A
  // caller that read it as a number would write a price of zero.
  ok('selling fixed: null, never 0', held !== 0)

  // And the margin is what absorbed it: the product was on 20% at a cost of
  // 100, and that same R138 shelf price against a cost of 110 is only 9.09%.
  ok('selling fixed: the product WAS on 20%', markupOf(100, 138, 15) === 20,
    String(markupOf(100, 138, 15)))
  ok('selling fixed: the MARKUP moved instead', markupOf(110, 138, 15) === 9.09,
    String(markupOf(110, 138, 15)))

  // ── Nothing to hold ────────────────────────────────────────────────────
  // A product costed for the first time has no markup to preserve. Inventing
  // one from a zero cost would price the line AT cost.
  const firstCost = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 0, newCostExcl: 75,
    currentSellIncl: 138, sellingVatPercent: 15,
  })
  ok('markup fixed: no previous cost -> price left alone', firstCost === null, String(firstCost))

  const freeGoods = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 100, newCostExcl: 0,
    currentSellIncl: 138, sellingVatPercent: 15,
  })
  ok('markup fixed: a zero new cost does not price at 0', freeGoods === null, String(freeGoods))

  const unpriced = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 100, newCostExcl: 120,
    currentSellIncl: 0, sellingVatPercent: 15,
  })
  ok('markup fixed: an unpriced product stays unpriced', unpriced === null, String(unpriced))

  // An unchanged cost must be a no-op in VALUE, not just in intent — a rule
  // that re-derived through rounding would nudge the shelf on every save.
  const noChange = repricedForCostChange({
    priceCalc: 'markup', oldCostExcl: 100, newCostExcl: 100,
    currentSellIncl: 138, sellingVatPercent: 15,
  })
  ok('markup fixed: an unchanged cost returns the same price', noChange === 138, String(noChange))

  // ── The markup survives repeated cost moves ────────────────────────────
  // Prices are stored to 4dp and markups read back off them, so a product that
  // is received 200 times must not creep off its markup one rounding at a time.
  let drift = 0
  let cost = 37.41
  let price = round(37.41 * 1.335 * 1.15, 4)
  const startMarkup = markupOf(cost, price, 15)
  for (let i = 0; i < 200; i++) {
    const nextCost = round(cost * (i % 2 === 0 ? 1.037 : 0.971), 4)
    const next = repricedForCostChange({
      priceCalc: 'markup', oldCostExcl: cost, newCostExcl: nextCost,
      currentSellIncl: price, sellingVatPercent: 15,
    })!
    cost = nextCost
    price = next
    if (Math.abs(markupOf(cost, price, 15) - startMarkup) > 0.01) drift++
  }
  ok('*** markup holds across 200 cost moves ***', drift === 0,
    `${drift} drifted; ended at ${markupOf(cost, price, 15)}% vs ${startMarkup}%`)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

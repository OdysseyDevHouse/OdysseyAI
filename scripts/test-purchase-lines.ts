/**
 * Purchase line arithmetic — the figures the ordering and receiving grids show.
 *
 * Pure: no database, no connection. That is the point. Every costing rule in
 * purchaseLine.ts is exhaustively checkable here, and a costing bug is silent —
 * it does not throw, it just quietly prices next month's GP report wrong.
 *
 * The rule that gets the most attention below is bonus quantities: free units
 * increase what arrives but not what is paid, so the landed cost must divide by
 * qty + bonus. Dividing by qty alone overstates the cost of every promotional
 * buy, and average_cost compounds that error with every receipt.
 *
 *   npm run test:purchase-lines
 */
import {
  lineDiscount,
  purchaseDocumentFigures,
  purchaseLineFigures,
  purchaseLineMargin,
  unitCostFromLineTotal,
  unitCostFromLineTotalIncl,
  type PurchaseLineValues,
} from '../src/app/(app)/purchasing/purchaseLine'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A line with sensible defaults, overridden per case. */
const line = (over: Partial<PurchaseLineValues> = {}): PurchaseLineValues => ({
  qty: 10,
  qtyBonus: 0,
  unitCostExcl: 100,
  discountPct: 0,
  discountAmount: 0,
  vatRatePct: 15,
  ...over,
})

function main() {
  console.log('\n── Line discount: absolute beats percentage ──')

  ok('a percentage comes off the gross', lineDiscount(line({ discountPct: 10 })) === 100)
  ok('an absolute amount is taken as given', lineDiscount(line({ discountAmount: 37.5 })) === 37.5)
  ok(
    '*** the absolute amount WINS when both are set ***',
    lineDiscount(line({ discountPct: 10, discountAmount: 37.5 })) === 37.5,
    String(lineDiscount(line({ discountPct: 10, discountAmount: 37.5 }))),
  )
  ok(
    'a discount cannot exceed the line',
    lineDiscount(line({ discountAmount: 9999 })) === 1000,
    String(lineDiscount(line({ discountAmount: 9999 }))),
  )
  ok('no discount is zero, not NaN', lineDiscount(line()) === 0)

  // The reason discount_amount exists at all: R37.50 off a R300.10 line is
  // 12.4958...%, and storing only the percentage cannot render the amount back.
  const awkward = purchaseLineFigures(line({ qty: 1, unitCostExcl: 300.1, discountAmount: 37.5 }))
  ok(
    '*** an absolute discount survives the round trip to the cent ***',
    awkward.discountExcl === 37.5 && awkward.netExcl === 262.6,
    `discount ${awkward.discountExcl}, net ${awkward.netExcl}`,
  )

  console.log('\n── Bonus quantities ──')

  const plain = purchaseLineFigures(line({ qty: 10, unitCostExcl: 100 }))
  ok('without bonus, landed cost is the unit cost', plain.landedCostExcl === 100)

  const bonus = purchaseLineFigures(line({ qty: 10, qtyBonus: 2, unitCostExcl: 100 }))
  ok(
    '*** bonus units DIVIDE the cost: 10 paid + 2 free = 83.3333 each ***',
    bonus.landedCostExcl === 83.3333,
    String(bonus.landedCostExcl),
  )
  ok(
    'bonus units do NOT add to what is owed',
    bonus.netExcl === 1000,
    String(bonus.netExcl),
  )
  ok('qtyTotal is what enters stock', bonus.qtyTotal === 12)

  // Buy 10 get 1 free, with freight — the case that catches a wrong divisor.
  const withFreight = purchaseLineFigures(line({ qty: 10, qtyBonus: 1, unitCostExcl: 50 }), 0, 60)
  ok(
    '*** freight spreads over paid AND free units ***',
    withFreight.landedCostExcl === round((500 + 60) / 11, 4),
    String(withFreight.landedCostExcl),
  )

  const allFree = purchaseLineFigures(line({ qty: 0, qtyBonus: 5, unitCostExcl: 100 }))
  ok('a wholly free line costs nothing per unit', allFree.landedCostExcl === 0)
  ok('a wholly free line owes nothing', allFree.netExcl === 0)

  const nothing = purchaseLineFigures(line({ qty: 0, qtyBonus: 0 }))
  ok('an empty line does not divide by zero', nothing.landedCostExcl === 0)

  console.log('\n── Order of operations ──')

  // Line discount, then document discount, then charges. Charges last because
  // freight is not discounted by the goods supplier's settlement terms.
  const ordered = purchaseLineFigures(
    line({ qty: 10, unitCostExcl: 100, discountPct: 10 }), // 1000 -> 900
    90, // document discount
    50, // freight
  )
  ok('line discount applies first', ordered.netExcl === 900)
  ok('document discount comes off the net', ordered.taxableExcl === 810)
  ok(
    'VAT is charged after BOTH discounts',
    ordered.lineVat === 121.5,
    String(ordered.lineVat),
  )
  ok(
    '*** charges are NOT discounted, but ARE in landed cost ***',
    ordered.landedCostExcl === 86,
    String(ordered.landedCostExcl),
  )

  console.log('\n── Document totals ──')

  const doc = purchaseDocumentFigures(
    [
      line({ qty: 10, unitCostExcl: 100 }),
      line({ qty: 5, unitCostExcl: 200 }),
      line({ qty: 1, unitCostExcl: 33.33 }),
    ],
    { discountPct: 10, chargesExcl: 100 },
  )
  ok('subtotal is the sum of net lines', doc.subtotalExcl === 2033.33, String(doc.subtotalExcl))
  ok('a percentage discount is taken on the subtotal', doc.discountExcl === 203.33, String(doc.discountExcl))

  const apportioned = doc.lines.reduce((s, l) => round(s + l.documentDiscountExcl, 2), 0)
  ok(
    '*** the apportioned discount sums to EXACTLY the discount asked for ***',
    apportioned === doc.discountExcl,
    `${apportioned} vs ${doc.discountExcl}`,
  )

  const spread = doc.lines.reduce((s, l) => round(s + l.chargeExcl, 2), 0)
  ok('*** apportioned charges sum to exactly the charge ***', spread === 100, String(spread))

  const taxable = doc.lines.reduce((s, l) => round(s + l.taxableExcl, 2), 0)
  ok('taxable is the sum of the lines', taxable === doc.taxableExcl)
  ok(
    'the document balances: taxable + charges + VAT = total',
    round(doc.taxableExcl + doc.chargesExcl + doc.vatTotal, 2) === doc.totalIncl,
    `${doc.taxableExcl} + ${doc.chargesExcl} + ${doc.vatTotal} vs ${doc.totalIncl}`,
  )

  // The classic apportionment trap: three equal lines and a discount that does
  // not divide by three. 100/3 = 33.333..., so naive rounding gives 99.99.
  const thirds = purchaseDocumentFigures(
    [line({ qty: 1, unitCostExcl: 100 }), line({ qty: 1, unitCostExcl: 100 }), line({ qty: 1, unitCostExcl: 100 })],
    { discountExcl: 100 },
  )
  const thirdsSum = thirds.lines.reduce((s, l) => round(s + l.documentDiscountExcl, 2), 0)
  ok(
    '*** a R100 discount over three equal lines is exactly R100 ***',
    thirdsSum === 100,
    String(thirdsSum),
  )

  const absolute = purchaseDocumentFigures([line({ qty: 10, unitCostExcl: 100 })], {
    discountPct: 50,
    discountExcl: 250,
  })
  ok('an absolute document discount beats the percentage', absolute.discountExcl === 250)

  const over = purchaseDocumentFigures([line({ qty: 1, unitCostExcl: 100 })], {
    discountExcl: 500,
  })
  ok(
    'a discount larger than the document is capped, not negative',
    over.discountExcl === 100 && over.taxableExcl === 0,
    `discount ${over.discountExcl}, taxable ${over.taxableExcl}`,
  )

  const empty = purchaseDocumentFigures([], { discountPct: 10, chargesExcl: 50 })
  ok('an empty document totals zero without dividing by zero', empty.subtotalExcl === 0 && empty.discountExcl === 0)

  console.log('\n── Margin ──')

  // Markup is profit over COST, GP is profit over SELL. A 100% markup is a 50%
  // GP, and confusing the two is the classic pricing error.
  const m = purchaseLineMargin(50, 115, 15)
  ok('selling excl. strips VAT', m.sellExcl === 100)
  ok('*** 50 cost, 100 sell = 100% markup ***', m.markup === 100, String(m.markup))
  ok('*** the same figures are a 50% GP ***', m.gp === 50, String(m.gp))
  ok('profit is per unit, excluding VAT both sides', m.profit === 50)

  const zeroCost = purchaseLineMargin(0, 115, 15)
  ok('a zero cost does not produce Infinity markup', Number.isFinite(zeroCost.markup))

  const zeroSell = purchaseLineMargin(50, 0, 15)
  ok('a zero selling price does not produce Infinity GP', Number.isFinite(zeroSell.gp))

  // Margin measured against LANDED cost, not invoice cost: the point of showing
  // GP while receiving is to answer "does this delivery still make money".
  const landed = purchaseLineFigures(line({ qty: 10, unitCostExcl: 50 }), 0, 100)
  const landedMargin = purchaseLineMargin(landed.landedCostExcl, 115, 15)
  ok(
    '*** freight reduces the margin it is measured against ***',
    landed.landedCostExcl === 60 && landedMargin.gp === 40,
    `landed ${landed.landedCostExcl}, gp ${landedMargin.gp}`,
  )

  console.log('\n── Never NaN, whatever it is fed ──')

  let bad = 0
  for (const qty of [0, 1, 7.5, 1000]) {
    for (const bonusQty of [0, 1, 3.333]) {
      for (const cost of [0, 0.0001, 199.99]) {
        for (const pct of [0, 12.5, 100]) {
          const f = purchaseLineFigures(
            line({ qty, qtyBonus: bonusQty, unitCostExcl: cost, discountPct: pct }),
            0,
            10,
          )
          for (const v of [f.netExcl, f.taxableExcl, f.landedCostExcl, f.lineVat, f.lineTotalIncl]) {
            if (!Number.isFinite(v)) bad++
          }
        }
      }
    }
  }
  ok('no combination produces NaN or Infinity', bad === 0, `${bad} bad values`)

  console.log('\n── Line total, run backwards into a unit cost ──')

  // The case the feature exists for: ten units, a line the buyer wants to come
  // to 120, and a cost of 12 falling out of it.
  ok(
    '*** a line total divides back into the unit cost ***',
    unitCostFromLineTotal(line({ qty: 10, unitCostExcl: 10 }), 120) === 12,
    String(unitCostFromLineTotal(line({ qty: 10, unitCostExcl: 10 }), 120)),
  )

  // It must round-trip: the cost it returns, run forwards, has to produce the
  // total that was typed. A one-cent drift here is a line that will not settle.
  for (const [qty, target] of [
    [10, 120],
    [3, 100],
    [7.5, 999.99],
    [1, 0.01],
  ] as const) {
    const cost = unitCostFromLineTotal(line({ qty }), target)
    const back = purchaseLineFigures(line({ qty, unitCostExcl: cost ?? 0 }))
    ok(
      `${qty} @ total ${target} round-trips`,
      cost !== null && Math.abs(back.taxableExcl - target) <= 0.01,
      `cost ${cost}, back ${back.taxableExcl}`,
    )
  }

  // A PERCENTAGE discount scales with the cost, so the gross must be divided
  // up rather than having a percentage of the target added back — that would
  // land short and settle the line at the wrong figure.
  const pctBack = unitCostFromLineTotal(line({ qty: 10, discountPct: 10 }), 900)
  const pctForward = purchaseLineFigures(line({ qty: 10, unitCostExcl: pctBack ?? 0, discountPct: 10 }))
  ok(
    '*** a percentage discount is divided out, not added back ***',
    pctBack === 100 && pctForward.taxableExcl === 900,
    `cost ${pctBack}, forward ${pctForward.taxableExcl}`,
  )

  // An ABSOLUTE discount is a rand figure off the invoice. It does not move
  // when the cost does, so it goes back on flat.
  const absBack = unitCostFromLineTotal(line({ qty: 10, discountAmount: 50 }), 950)
  const absForward = purchaseLineFigures(
    line({ qty: 10, unitCostExcl: absBack ?? 0, discountAmount: 50 }),
  )
  ok(
    'an absolute discount is added back flat',
    absBack === 100 && absForward.taxableExcl === 950,
    `cost ${absBack}, forward ${absForward.taxableExcl}`,
  )

  // The document discount came off this line flat, so it goes back on flat too.
  const docBack = unitCostFromLineTotal(line({ qty: 10 }), 900, 100)
  const docForward = purchaseLineFigures(line({ qty: 10, unitCostExcl: docBack ?? 0 }), 100)
  ok(
    'a document-discount share is carried through the inversion',
    docBack === 100 && docForward.taxableExcl === 900,
    `cost ${docBack}, forward ${docForward.taxableExcl}`,
  )

  // BONUS UNITS ARE NOT PAID FOR. The total is divided across qty alone, so a
  // free unit must not drag the cost down — the mirror of the landed-cost rule.
  ok(
    '*** bonus units do not share the line total ***',
    unitCostFromLineTotal(line({ qty: 10, qtyBonus: 5 }), 120) === 12,
    String(unitCostFromLineTotal(line({ qty: 10, qtyBonus: 5 }), 120)),
  )

  console.log('\n── The inclusive box strips VAT and hands over ──')

  ok(
    '*** an inclusive line total reaches the same cost ***',
    unitCostFromLineTotalIncl(line({ qty: 10, vatRatePct: 15 }), 138) === 12,
    String(unitCostFromLineTotalIncl(line({ qty: 10, vatRatePct: 15 }), 138)),
  )
  const inclForward = purchaseLineFigures(
    line({ qty: 10, unitCostExcl: unitCostFromLineTotalIncl(line({ qty: 10 }), 138) ?? 0 }),
  )
  ok(
    'and the inclusive total comes back out',
    inclForward.lineTotalIncl === 138,
    String(inclForward.lineTotalIncl),
  )
  ok(
    'a zero-rated line inverts on the exclusive figure',
    unitCostFromLineTotalIncl(line({ qty: 10, vatRatePct: 0 }), 120) === 12,
  )

  console.log('\n── It refuses rather than returning nonsense ──')

  ok('no quantity to divide by', unitCostFromLineTotal(line({ qty: 0 }), 120) === null)
  ok('a negative total', unitCostFromLineTotal(line({ qty: 10 }), -5) === null)
  ok('a 100% discount', unitCostFromLineTotal(line({ qty: 10, discountPct: 100 }), 120) === null)
  ok('NaN in, null out', unitCostFromLineTotal(line({ qty: 10 }), Number.NaN) === null)
  ok('a zero total is legitimate, not a refusal', unitCostFromLineTotal(line({ qty: 10 }), 0) === 0)
  ok('no quantity, inclusive box too', unitCostFromLineTotalIncl(line({ qty: 0 }), 138) === null)

  let badBack = 0
  for (const qty of [0, 1, 7.5, 1000]) {
    for (const target of [0, 0.01, 120, 999999]) {
      for (const pct of [0, 12.5, 100]) {
        for (const amount of [0, 50]) {
          const v = unitCostFromLineTotal(
            line({ qty, discountPct: pct, discountAmount: amount }),
            target,
          )
          if (v !== null && !Number.isFinite(v)) badBack++
        }
      }
    }
  }
  ok('no combination inverts to NaN or Infinity', badBack === 0, `${badBack} bad values`)

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

import {
  lineTotals, splitIncl, documentTotals, apportionDiscount, roundToCash,
  assertBalanced, lineMargin,
} from '../src/lib/documentMath'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function main() {
  // ── Rule 2: VAT by subtraction ─────────────────────────────────────────
  ok('115 @15% -> excl 100, vat 15', JSON.stringify(splitIncl(115, 15)) === JSON.stringify({ excl: 100, vat: 15 }), JSON.stringify(splitIncl(115, 15)))
  ok('zero-rated leaves VAT at 0', JSON.stringify(splitIncl(99.99, 0)) === JSON.stringify({ excl: 99.99, vat: 0 }))

  // The whole reason for subtraction: excl + vat must ALWAYS equal incl, at
  // EVERY rate. Subtraction is exact by construction; independent computation
  // is not, and which rates expose that is a coincidence not worth relying on.
  let mismatch = 0
  for (const rate of [0, 5, 7, 12.5, 14, 15, 20, 23]) {
    for (let cents = 1; cents <= 25000; cents++) {
      const incl = cents / 100
      const { excl, vat } = splitIncl(incl, rate)
      if (round(excl + vat, 2) !== incl) mismatch++
    }
  }
  ok('*** excl+vat===incl across 8 rates x 25 000 amounts ***', mismatch === 0, `${mismatch} mismatches`)

  // And the independent computation genuinely does break — at 20%, often.
  let naiveBreaks = 0
  for (let cents = 1; cents <= 25000; cents++) {
    const incl = cents / 100
    const { vat } = splitIncl(incl, 20)
    if (round((incl * 20) / 120, 2) !== vat) naiveBreaks++
  }
  ok('    naive independent VAT diverges at 20%', naiveBreaks > 0, `${naiveBreaks} of 25 000 (~1 in ${Math.round(25000 / naiveBreaks)})`)

  // Negative amounts: a credit note line must split symmetrically.
  ok('negative splits symmetrically (-115 -> -100/-15)', JSON.stringify(splitIncl(-115, 15)) === JSON.stringify({ excl: -100, vat: -15 }), JSON.stringify(splitIncl(-115, 15)))

  // ── Lines ──────────────────────────────────────────────────────────────
  const l1 = lineTotals({ qty: 3, unitPriceIncl: 14.99, vatRatePct: 15 })
  ok('3 x 14.99 = 44.97 incl', l1.lineTotalIncl === 44.97, String(l1.lineTotalIncl))
  ok('line splits exactly', round(l1.lineTotalExcl + l1.lineVat, 2) === l1.lineTotalIncl, `${l1.lineTotalExcl}+${l1.lineVat}`)

  const l2 = lineTotals({ qty: 2, unitPriceIncl: 100, discountPct: 10, vatRatePct: 15 })
  ok('10% off 200 -> 180 incl', l2.lineTotalIncl === 180 && l2.discountIncl === 20, `${l2.lineTotalIncl}/${l2.discountIncl}`)

  const l3 = lineTotals({ qty: 1, unitPriceIncl: 100, discountPct: 10, discountIncl: 25, vatRatePct: 15 })
  ok('absolute discount wins over percentage', l3.discountIncl === 25 && l3.lineTotalIncl === 75)

  const l4 = lineTotals({ qty: -2, unitPriceIncl: 57.5, vatRatePct: 15 })
  ok('credit note line is negative throughout', l4.lineTotalIncl === -115 && l4.lineVat === -15, `${l4.lineTotalIncl}/${l4.lineVat}`)

  // ── Rule 1: the line is the only rounding boundary ─────────────────────
  // Three lines that each round, on a mixed-rate basket.
  const basket = [
    { ...lineTotals({ qty: 3, unitPriceIncl: 14.99, vatRatePct: 15 }), vatRatePct: 15 },
    { ...lineTotals({ qty: 7, unitPriceIncl: 2.35, vatRatePct: 15 }), vatRatePct: 15 },
    { ...lineTotals({ qty: 1, unitPriceIncl: 18.5, vatRatePct: 0 }), vatRatePct: 0 },  // zero-rated bread
  ]
  const totals = documentTotals(basket)
  ok('mixed-rate: excl + VAT === total', round(totals.subtotalExcl + totals.vatTotal, 2) === totals.totalIncl,
    `${totals.subtotalExcl}+${totals.vatTotal} vs ${totals.totalIncl}`)
  ok('VAT analysed per rate (2 rates)', totals.vatByRate.length === 2, JSON.stringify(totals.vatByRate))
  ok('zero-rated line carries no VAT', totals.vatByRate.find(r => r.ratePct === 0)?.vat === 0)
  let threw = false
  try { assertBalanced(totals) } catch { threw = true }
  ok('assertBalanced passes on a good document', !threw)

  // assertBalanced must actually catch a bad one.
  threw = false
  try { assertBalanced({ ...totals, totalIncl: round(totals.totalIncl + 0.01, 2) }) } catch { threw = true }
  ok('assertBalanced throws on an unbalanced document', threw)

  // ── Rule 3: discount apportionment ────────────────────────────────────
  const shares = apportionDiscount([100, 50, 33.33], 20)
  const allocated = round(shares.reduce((a, b) => a + b, 0), 2)
  ok('apportioned discount sums to exactly the discount', allocated === 20, `${allocated} from ${JSON.stringify(shares)}`)

  // The awkward case: a discount that cannot divide evenly.
  const awkward = apportionDiscount([33.33, 33.33, 33.34], 10)
  ok('awkward split still sums exactly', round(awkward.reduce((a, b) => a + b, 0), 2) === 10, JSON.stringify(awkward))

  // Remainder lands on the largest line, not the first.
  const uneven = apportionDiscount([10, 200, 10], 1)
  const maxIdx = uneven.indexOf(Math.max(...uneven))
  ok('remainder goes to the largest line', maxIdx === 1, JSON.stringify(uneven))
  ok('zero discount apportions to zeroes', apportionDiscount([10, 20], 0).every(v => v === 0))

  // ── Rule 4: cash rounding applies to the tender ───────────────────────
  ok('432.47 -> 432.45 at 5c (adj -0.02)', JSON.stringify(roundToCash(432.47, 0.05)) === JSON.stringify({ rounded: 432.45, adjustment: -0.02 }), JSON.stringify(roundToCash(432.47, 0.05)))
  ok('432.43 -> 432.45 at 5c (adj +0.02)', JSON.stringify(roundToCash(432.43, 0.05)) === JSON.stringify({ rounded: 432.45, adjustment: 0.02 }), JSON.stringify(roundToCash(432.43, 0.05)))
  ok('exact multiple is unchanged', roundToCash(432.45, 0.05).adjustment === 0)
  ok('10c rounding works too', roundToCash(432.47, 0.10).rounded === 432.5, String(roundToCash(432.47, 0.10).rounded))
  ok('denomination 0 disables rounding', roundToCash(432.47, 0).adjustment === 0)

  // Rounding must never move by more than half a denomination.
  let maxDrift = 0
  for (let c = 1; c <= 20000; c++) {
    const { adjustment } = roundToCash(c / 100, 0.05)
    maxDrift = Math.max(maxDrift, Math.abs(adjustment))
  }
  ok('cash rounding never drifts more than 2.5c', maxDrift <= 0.025, `max ${maxDrift}`)

  // ── Margin ─────────────────────────────────────────────────────────────
  const m = lineMargin(100, 60, 1)
  ok('GP% is profit over SELLING (40%)', m.gpPct === 40 && m.profit === 40, JSON.stringify(m))
  ok('zero selling price gives 0% not NaN', lineMargin(0, 10, 1).gpPct === 0)

  // ── The end-to-end invariant on random baskets ────────────────────────
  let unbalanced = 0
  for (let trial = 0; trial < 5000; trial++) {
    const n = 1 + (trial % 8)
    const lines = []
    for (let i = 0; i < n; i++) {
      const rate = [0, 15][(trial + i) % 2]
      lines.push({
        ...lineTotals({
          qty: 1 + ((trial * 7 + i * 3) % 12),
          unitPriceIncl: round(((trial * 13 + i * 29) % 50000) / 100 + 0.01, 2),
          discountPct: (trial + i) % 4 === 0 ? 7.5 : 0,
          vatRatePct: rate,
        }),
        vatRatePct: rate,
      })
    }
    const t = documentTotals(lines)
    if (round(t.subtotalExcl + t.vatTotal, 2) !== t.totalIncl) unbalanced++
  }
  ok('*** 5 000 random baskets all balance ***', unbalanced === 0, `${unbalanced} unbalanced`)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

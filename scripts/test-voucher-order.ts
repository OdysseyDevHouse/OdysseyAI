/**
 * A voucher, cash rounding, and the order the two are applied in.
 *
 *   npx tsx scripts/test-voucher-order.ts
 *
 * Pure — no database, no browser. What is under test is one line of arithmetic that
 * appears in three places and MUST agree in all three:
 *
 *   finaliseDocument   round(totalIncl) − voucher      ← the authority
 *   the touch pad      round(totalIncl) − voucher      ← matched to it
 *   the desk pad       round(totalIncl − voucher)      ← DIFFERENT, and wrong
 *
 * The two orders give the same answer most of the time, which is exactly why the
 * difference survives: it only shows up when the voucher value lands such that the
 * rounding falls differently. Then the pad says one figure, the server insists on
 * another, and a correctly-tendered sale is refused in front of the customer.
 *
 * This file exists so that a change to either pad has something to disagree with.
 */
import { roundToCash } from '../src/lib/documentMath'
import { round } from '../src/lib/decimals'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The engine's order, as `finaliseDocument` does it. THE authority. */
function engineOrder(totalIncl: number, voucher: number, denomination: number): number {
  const { rounded } = denomination > 0 ? roundToCash(totalIncl, denomination) : { rounded: totalIncl }
  return round(Math.max(0, rounded - voucher), 2)
}

/** The other order — round after subtracting. What the desk pad does. */
function subtractFirst(totalIncl: number, voucher: number, denomination: number): number {
  const net = round(Math.max(0, totalIncl - voucher), 2)
  const { rounded } = denomination > 0 ? roundToCash(net, denomination) : { rounded: net }
  return rounded
}

function main() {
  /* ── 1. The orders agree far more often than they differ ────────────────
     Which is the point: a difference that showed up on every sale would have been
     found on the first one. */

  let same = 0
  let differ: { total: number; voucher: number; engine: number; other: number }[] = []
  for (let cents = 0; cents <= 20_000; cents++) {
    const total = round(cents / 100, 2)
    for (const voucher of [0, 5, 10, 25, 25.03, 49.99]) {
      const a = engineOrder(total, voucher, 0.05)
      const b = subtractFirst(total, voucher, 0.05)
      if (a === b) same++
      else if (differ.length < 5) differ.push({ total, voucher, engine: a, other: b })
    }
  }

  /* Most, but nowhere near all. MEASURED at 87,505 of 120,006 combinations — so roughly a
     QUARTER of them disagree, which is far too often to be a curiosity. That figure is
     the reason this order has to be pinned rather than left to whichever reading came
     first: at one sale in four, the pad and the server would name different amounts. */
  ok('the two orders agree on most amounts', same > 80_000, `${same} of 120006 agreed`)
  ok(
    '*** but NOT on all of them — which is why the order matters ***',
    differ.length > 0,
    differ
      .slice(0, 3)
      .map((d) => `R${d.total} less R${d.voucher}: engine ${d.engine} vs ${d.other}`)
      .join(' | '),
  )

  /* ── 2. A worked example, so the difference is legible ──────────────────── */

  // R100.02 with a R25.03 voucher, 5c rounding.
  //   engine:  round(100.02) = 100.00, less 25.03 = 74.97
  //   other:   100.02 − 25.03 = 74.99, rounded = 75.00
  // Three cents apart, and the till would refuse a R74.97 payment.
  ok(
    'R100.02 less a R25.03 voucher is R74.97 the engine way',
    engineOrder(100.02, 25.03, 0.05) === 74.97,
    String(engineOrder(100.02, 25.03, 0.05)),
  )
  ok(
    '  and R75.00 the other way — a 3c refusal at the counter',
    subtractFirst(100.02, 25.03, 0.05) === 75,
    String(subtractFirst(100.02, 25.03, 0.05)),
  )

  /* ── 3. With no rounding configured, the order cannot matter ─────────────
     Most stores. Worth asserting so nobody "simplifies" the pad on the grounds that
     it makes no difference — it makes none HERE, and all the difference at 5c. */

  let anyDiff = false
  for (let cents = 0; cents <= 5_000; cents++) {
    const total = round(cents / 100, 2)
    if (engineOrder(total, 25.03, 0) !== subtractFirst(total, 25.03, 0)) anyDiff = true
  }
  ok('with rounding off, both orders are identical', !anyDiff)

  /* ── 4. A voucher never makes a sale owe less than nothing ───────────────
     Both clamp at zero. A negative payable would have checkTenders reporting change on
     a sale nobody paid for. */

  ok('a voucher larger than the sale leaves zero owing', engineOrder(20, 50, 0.05) === 0)
  ok('  and not a negative', engineOrder(20, 50, 0.05) >= 0)

  console.log(fails === 0 ? '\nAll voucher-order checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()

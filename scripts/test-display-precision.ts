/**
 * Quantity and cost decimals — what the shop's setting may and may not change.
 *
 *   npx tsx scripts/test-display-precision.ts
 *
 * Pure: `formatQty` and `formatCost` read a module-level value, so this needs
 * no database and no request. That is the whole layer the rules live in.
 *
 * What is worth proving:
 *
 *   · A FRACTION IS NEVER ROUNDED AWAY. At 0 decimals a 1.5kg line must not
 *     print as "2". The setting says how a COUNT is shown; it does not license
 *     showing a different number, and a wrong quantity on an invoice is a
 *     document somebody pays against. This is the one rule that must not break.
 *
 *   · THE THOUSANDS SEPARATOR SURVIVES 3 AND 4 DECIMALS. formatMoney's regex
 *     groups every run of three digits from the END of the string, which is
 *     right at exactly two decimals and produces "1 234.5 000" at four — the
 *     bug formatCost exists to avoid, and the reason it cannot just call
 *     formatMoney with a places argument.
 *
 *   · AN OUT-OF-RANGE VALUE IS IGNORED, not clamped. A bad number means a
 *     setting that failed validation or a caller passing nonsense, and keeping
 *     the last good value beats inventing a format nobody chose.
 */
import {
  formatQty,
  formatCost,
  formatMoney,
  setDisplayPrecision,
  displayPrecision,
} from '../src/lib/decimals'

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  )
}

function main() {
  console.log('\n── Quantities: whole numbers follow the setting ───────────────')
  setDisplayPrecision({ qty: 0 })
  check('0 places — a count is a whole number', formatQty(1), '1')
  check('0 places — ten', formatQty(10), '10')
  check('0 places — eleven', formatQty(11), '11')

  setDisplayPrecision({ qty: 2 })
  check('2 places pads a whole number', formatQty(1), '1.00')
  check('2 places — eleven', formatQty(11), '11.00')

  setDisplayPrecision({ qty: 3 })
  check('3 places', formatQty(7), '7.000')

  console.log('\n── But a FRACTION is never rounded away ───────────────────────')
  setDisplayPrecision({ qty: 0 })
  check('1.5 kg at 0 places keeps its half', formatQty(1.5), '1.5')
  check('2.4 m at 0 places', formatQty(2.4), '2.4')
  check('0.125 at 0 places', formatQty(0.125), '0.125')
  setDisplayPrecision({ qty: 1 })
  check('1.25 at 1 place is not truncated either', formatQty(1.25), '1.25')

  console.log('\n── The exact escape hatch — what paper uses ───────────────────')
  setDisplayPrecision({ qty: 0 })
  check('exact keeps the old trimming', formatQty(1), '1')
  check('exact on a whole number does not pad', formatQty(1, { exact: true }), '1')
  check('exact on a fraction', formatQty(1.5, { exact: true }), '1.5')
  setDisplayPrecision({ qty: 3 })
  check('exact ignores a 3-place setting', formatQty(4, { exact: true }), '4')

  console.log('\n── Costs ─────────────────────────────────────────────────────')
  setDisplayPrecision({ cost: 2 })
  check('2 places', formatCost(12.5), 'R12.50')
  check('2 places rounds a longer figure', formatCost(0.0875), 'R0.09')

  setDisplayPrecision({ cost: 4 })
  check('4 places shows the real cost', formatCost(0.0875), 'R0.0875')
  check('4 places pads', formatCost(12.5), 'R12.5000')

  console.log('\n── The separator, which is where formatMoney would break ──────')
  setDisplayPrecision({ cost: 2 })
  check('thousands at 2 places', formatCost(1234.5), 'R1 234.50')
  setDisplayPrecision({ cost: 4 })
  check('thousands at 4 places', formatCost(1234.5), 'R1 234.5000')
  setDisplayPrecision({ cost: 3 })
  check('thousands at 3 places', formatCost(12345.678), 'R12 345.678')
  check('millions at 3 places', formatCost(1234567.891), 'R1 234 567.891')
  check('a negative cost keeps its sign in front of the symbol', formatCost(-1234.5), '-R1 234.500')

  console.log('\n── formatMoney is untouched ──────────────────────────────────')
  /* Selling prices are money and money has two decimals — a third would be a
     price no customer can pay. The cost setting must not leak into it. */
  setDisplayPrecision({ cost: 4 })
  check('money stays at two places', formatMoney(1234.5), 'R1 234.50')
  check('money still groups correctly', formatMoney(12345.678), 'R12 345.68')

  console.log('\n── Out-of-range input is ignored, not clamped ────────────────')
  setDisplayPrecision({ qty: 2, cost: 2 })
  setDisplayPrecision({ qty: 9 })
  check('a qty of 9 is refused', displayPrecision().qty, 2)
  setDisplayPrecision({ qty: -1 })
  check('a negative qty is refused', displayPrecision().qty, 2)
  setDisplayPrecision({ qty: 1.5 })
  check('a fractional qty is refused', displayPrecision().qty, 2)
  setDisplayPrecision({ cost: 1 })
  check('a cost of 1 is refused — below what a cost is quoted at', displayPrecision().cost, 2)
  setDisplayPrecision({ cost: 5 })
  check('a cost of 5 is refused — beyond the column', displayPrecision().cost, 2)
  setDisplayPrecision({ qty: Number.NaN })
  check('NaN is refused', displayPrecision().qty, 2)

  console.log('\n── Setting one does not disturb the other ────────────────────')
  setDisplayPrecision({ qty: 0, cost: 4 })
  setDisplayPrecision({ qty: 3 })
  check('cost survives a qty-only call', displayPrecision().cost, 4)
  check('and qty took', displayPrecision().qty, 3)

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check${failures === 1 ? '' : 's'} FAILED.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main()

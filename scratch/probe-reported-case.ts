/**
 * The tester's report, checked as pure arithmetic — no database.
 *
 * Reported: product code 5432, set to variable price, barcode 6054321015996,
 * expected R15.99, got the right item at the wrong price.
 *
 * Runs the barcode through every rule shape that could plausibly have been
 * configured for it, so the answer says WHICH shapes give 15.99 and which do
 * not — a single passing shape would not tell us whether the tester's own
 * settings were among them.
 */
import { parseVariableBarcode, type ScaleBarcodeRule } from '../src/lib/barcodes'

const CODE = '6054321015996'
const PLU = '5432'

function show(name: string, rule: ScaleBarcodeRule) {
  const r = parseVariableBarcode(CODE, rule)
  const shape = `prefix ${rule.prefix} / code ${rule.pluLength} / value ${rule.valueLength || 'rest'} / check ${rule.hasCheckDigit ? 'yes' : 'no'} / dec ${rule.decimals}`
  const verdict =
    r === null ? 'NO MATCH'
    : r.plu !== PLU ? `wrong item (${r.plu})`
    : r.value === 15.99 ? 'R15.99  <-- correct'
    : `right item, WRONG PRICE R${r.value.toFixed(2)}`
  console.log(`  ${name.padEnd(34)} ${shape.padEnd(56)} ${verdict}`)
}

console.log(`\nbarcode ${CODE}, expecting item ${PLU} at R15.99\n`)

show('60 / 4 / 5 (the tester shape)', { prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2 })
show('60 / 4 / rest', { prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 0, decimals: 2 })
show('6 / 5 / 5', { prefix: '6', pluLength: 5, hasCheckDigit: true, valueLength: 5, decimals: 2 })
show('60 / 4 / 5, no check digit', { prefix: '60', pluLength: 4, hasCheckDigit: false, valueLength: 5, decimals: 2 })
show('60 / 4 / 5, grams (dec 3)', { prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 3 })
show('60 / 4 / 6', { prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 6, decimals: 2 })
show('2 / 5 / 5 (the default rule)', { prefix: '2', pluLength: 5, hasCheckDigit: true, valueLength: 5, decimals: 2 })
console.log()

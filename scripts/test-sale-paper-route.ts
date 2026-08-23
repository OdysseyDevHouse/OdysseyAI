// The rule this exists for: which paper a till hands a customer for a finished
// sale, decided by the till's MODE and nothing else.
//
// A trade counter (pos_mode 'invoicing') owes an account customer the A4 tax
// invoice — the banking block, VAT number and terms live only there. A retail
// or hospitality till owes the 80mm slip, because the customer is standing at
// the counter waiting for it.
//
// Imports the REAL salePaperRoute. A copy of the rule here would pass happily
// while the till printed the other thing.
import { salePaperRoute } from '../src/lib/salePaper'
import { POS_MODES } from '../src/lib/posMode'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${String(actual)}, expected ${String(expected)}`)
}

check('trade counter prints the A4 document', salePaperRoute('invoicing'), 'document')
check('retail prints the slip', salePaperRoute('retail'), 'slip')
check('hospitality prints the slip', salePaperRoute('hospitality'), 'slip')

/*
 * Every mode the app knows must be covered here, so a fourth one cannot quietly
 * inherit slip paper without somebody deciding that is what it should get.
 * Named explicitly rather than looped over POS_MODES — a loop asserting
 * "returns one of two strings" would pass for a function that always answered
 * 'slip'.
 */
const covered = ['retail', 'hospitality', 'invoicing']
const uncovered = POS_MODES.filter((m) => !covered.includes(m))
check(`no mode is unaccounted for (POS_MODES = ${POS_MODES.join(', ')})`, uncovered.join(',') || 'none', 'none')

console.log(failures === 0 ? '\nAll sale-paper routing checks passed.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)

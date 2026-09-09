/* The recipe weight factor. The stored number is a FRACTION OF A PURCHASED
   UNIT, so an error here is invisible: it costs and deducts the wrong thing
   without anything complaining. */
import { weightFactor, usageUnitFor, factorSentence, type FactorUnit } from '../src/lib/recipeFactor'

let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) { pass++; console.log(`  PASS  ${name.padEnd(46)} ${got}`) }
  else { fail++; console.log(`  FAIL  ${name.padEnd(46)} got ${got}, wanted ${want}`) }
}

console.log('The screenshots: 10 Kg box, 200 g a burger')
check('factor', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: 200, usageUnit: 'g' }), 0.02)
check('sentence', factorSentence('Burger', 'Beef Patties (4)', 0.02, 'Kg'),
  'When selling a Burger you will be using 0,02 Kg of Beef Patties (4).')

console.log('\nThe usage unit steps down once, then stays')
check('Kg -> ', usageUnitFor('Kg'), 'g')
check('g -> ', usageUnitFor('g'), 'g')
check('L -> ', usageUnitFor('L'), 'ml')
check('ml -> ', usageUnitFor('ml'), 'ml')
check('Each -> ', usageUnitFor('Each'), 'Each')

console.log('\nSame-unit and volume cases')
check('1000 g bag, 200 g used', weightFactor({ buyingQty: 1000, buyingUnit: 'g', usageQty: 200, usageUnit: 'g' }), 0.2)
check('5 L drum, 250 ml used', weightFactor({ buyingQty: 5, buyingUnit: 'L', usageQty: 250, usageUnit: 'ml' }), 0.05)
check('750 ml bottle, 25 ml tot', weightFactor({ buyingQty: 750, buyingUnit: 'ml', usageQty: 25, usageUnit: 'ml' }), 0.0333)
check('24 case, 2 tins used', weightFactor({ buyingQty: 24, buyingUnit: 'Each', usageQty: 2, usageUnit: 'Each' }), 0.0833)
check('whole pack used', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: 10000, usageUnit: 'g' }), 1)
check('zero usage is legitimate', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: 0, usageUnit: 'g' }), 0)

console.log('\nRefused — must be null, never a guessed number')
check('zero pack (divide by zero)', weightFactor({ buyingQty: 0, buyingUnit: 'Kg', usageQty: 200, usageUnit: 'g' }), null)
check('negative pack', weightFactor({ buyingQty: -10, buyingUnit: 'Kg', usageQty: 200, usageUnit: 'g' }), null)
check('negative usage', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: -5, usageUnit: 'g' }), null)
check('NaN', weightFactor({ buyingQty: NaN, buyingUnit: 'Kg', usageQty: 200, usageUnit: 'g' }), null)
check('grams into litres (no density)', weightFactor({ buyingQty: 5, buyingUnit: 'L', usageQty: 200, usageUnit: 'g' }), null)
check('Each into Kg', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: 2, usageUnit: 'Each' }), null)

console.log('\nRounding is to what the qty column stores (4dp)')
check('1/3 of a pack', weightFactor({ buyingQty: 3, buyingUnit: 'Each', usageQty: 1, usageUnit: 'Each' }), 0.3333)
check('tiny but real', weightFactor({ buyingQty: 10, buyingUnit: 'Kg', usageQty: 1, usageUnit: 'g' }), 0.0001)
// Below 4dp a real usage rounds to nothing. It must round to 0, not to null:
// the dialog then shows 0 and the person sees the pack is too big to divide.
check('below 4dp rounds to zero', weightFactor({ buyingQty: 1000, buyingUnit: 'Kg', usageQty: 0.01, usageUnit: 'g' }), 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

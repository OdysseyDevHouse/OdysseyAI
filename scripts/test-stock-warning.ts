/**
 * The out-of-stock warning — pure, no database, no browser.
 *
 *   npx tsx scripts/test-stock-warning.ts
 *
 * What is checked is the four things the rule has to get right: it stays quiet
 * about what it cannot know, it sums a product across lines before judging it,
 * a return never causes a shortage, and the message names something a cashier
 * can act on.
 */
import { stockShortfalls, stockWarning, type StockLine } from '../src/lib/stockWarning'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const line = (over: Partial<StockLine> = {}): StockLine => ({
  productId: 1,
  description: 'Widget',
  qty: 1,
  onHand: 10,
  tracked: true,
  ...over,
})

/* ── Nothing to say ───────────────────────────────────────────────────── */

ok('an empty basket is quiet', stockShortfalls([]).length === 0)
ok('a basket within stock is quiet', stockShortfalls([line({ qty: 3, onHand: 10 })]).length === 0)
ok(
  'selling EXACTLY what is on hand is fine',
  stockShortfalls([line({ qty: 10, onHand: 10 })]).length === 0,
)

/* ── What it cannot know, it does not claim ───────────────────────────── */

ok(
  'an untracked product is silent even at zero',
  stockShortfalls([line({ qty: 5, onHand: 0, tracked: false })]).length === 0,
)
ok(
  'an unknown on-hand is silent, not a shortage',
  stockShortfalls([line({ qty: 5, onHand: null })]).length === 0,
)
ok(
  'a line with no product is silent',
  stockShortfalls([line({ qty: 5, onHand: 0, productId: null })]).length === 0,
)

/* ── The real shortage ────────────────────────────────────────────────── */

const one = stockShortfalls([line({ qty: 12, onHand: 10 })])
ok('selling more than is held is a shortfall', one.length === 1)
ok('  and it says how many are missing', one[0]?.short === 2, String(one[0]?.short))
ok('  carrying what was wanted', one[0]?.wanted === 12)
ok('  and what is held', one[0]?.onHand === 10)

const negative = stockShortfalls([line({ qty: 1, onHand: -3 })])
ok('a product already counted negative is short', negative.length === 1)
ok('  by the whole gap', negative[0]?.short === 4, String(negative[0]?.short))

/* ── THE ONE A LINE-BY-LINE CHECK MISSES ──────────────────────────────── */

const split = stockShortfalls([
  line({ productId: 7, qty: 3, onHand: 4 }),
  line({ productId: 7, qty: 2, onHand: 4 }),
])
ok(
  '*** the same product on two lines is summed before judging ***',
  split.length === 1,
  `got ${split.length}`,
)
ok('  3 + 2 against 4 is one short', split[0]?.short === 1, String(split[0]?.short))
ok('  and it is reported once, not twice', split.filter((s) => s.productId === 7).length === 1)

const splitFine = stockShortfalls([
  line({ productId: 7, qty: 2, onHand: 5 }),
  line({ productId: 7, qty: 3, onHand: 5 }),
])
ok('  but summing to exactly the stock is still fine', splitFine.length === 0)

/* ── A return puts stock BACK ─────────────────────────────────────────── */

ok(
  'a return line is not a shortage',
  stockShortfalls([line({ qty: -5, onHand: 0 })]).length === 0,
)
const mixed = stockShortfalls([
  line({ productId: 9, qty: 6, onHand: 4 }),
  line({ productId: 9, qty: -3, onHand: 4 }),
])
ok(
  '*** and it cannot net away a real shortage ***',
  mixed.length === 1 && mixed[0]?.short === 2,
  JSON.stringify(mixed),
)

/* ── Worst first ──────────────────────────────────────────────────────── */

const many = stockShortfalls([
  line({ productId: 1, description: 'Small gap', qty: 3, onHand: 2 }),
  line({ productId: 2, description: 'Big gap', qty: 20, onHand: 1 }),
  line({ productId: 3, description: 'Middle gap', qty: 8, onHand: 3 }),
])
ok('every shortfall is reported', many.length === 3, String(many.length))
ok('  worst first', many[0]?.description === 'Big gap', String(many[0]?.description))
ok('  then the next', many[1]?.description === 'Middle gap', String(many[1]?.description))

/* ── The message ──────────────────────────────────────────────────────── */

ok('no shortfalls means no message', stockWarning([]) === null)

const oneMsg = stockWarning(stockShortfalls([line({ description: 'Hammer', qty: 5, onHand: 2 })]))
ok('one shortfall names the product', oneMsg?.includes('Hammer') === true, String(oneMsg))
ok('  and both figures', oneMsg?.includes('5') === true && oneMsg?.includes('2') === true, String(oneMsg))

const twoMsg = stockWarning(many.slice(0, 2))
ok('two shortfalls counts the other', twoMsg?.includes('1 other item') === true, String(twoMsg))
const threeMsg = stockWarning(many)
ok('  and three pluralises', threeMsg?.includes('2 other items') === true, String(threeMsg))
ok('  still naming the worst one', threeMsg?.includes('Big gap') === true, String(threeMsg))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)

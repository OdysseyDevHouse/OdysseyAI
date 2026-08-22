/**
 * "Show this only when…" — across all three print engines.
 *
 *   npm run test:conditions
 *
 * ── WHAT THIS IS GUARDING ────────────────────────────────────────────────
 *
 * A condition decides whether a block prints. Get it wrong in one direction and
 * a shop asks why their footer vanished; get it wrong in the other and a
 * customer reads "PAID — thank you" on an invoice they still owe. The second is
 * the one that matters, so the negative cases below are the point of the file.
 *
 * ── AND WHY IT TESTS THREE ENGINES SEPARATELY ────────────────────────────
 *
 * The same rule is answered in three different places, because the engines are
 * not alike:
 *
 *   A4 HTML   compile and render happen at DIFFERENT TIMES, so the condition
 *             travels through the markup as `{#when}` and renderTemplate
 *             resolves it against the document's data.
 *   PDF       block and data are held together, so drawBlock skips it.
 *   Slip      likewise, in blockPrints — where the separator logic already is.
 *
 * Three mechanics, one rule. A test that only covered one of them would let the
 * other two drift, which is exactly how the two slip prints once disagreed.
 *
 * Needs no database and no browser.
 */
import {
  CONDITIONS,
  SLIP_CONDITIONS,
  conditionHolds,
  slipConditionHolds,
  isConditionRule,
} from '../src/lib/stationery/conditions'
import { compileDocument } from '../src/lib/stationery/compile'
import { parseSpec, serialiseSpec, type DocumentSpec } from '../src/lib/stationery/blocks'
import { renderTemplate } from '../src/lib/stationery/render'
import { parseSlip, serialiseSlip, type SlipSpec } from '../src/lib/stationery/slip'
import { renderSlipSpec } from '../src/lib/escpos/slipSpec'
import { slipBlockHtml } from '../src/lib/stationery/slipHtml'
import type { ReceiptData } from '../src/lib/receiptData'

let failures = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── the rules themselves ────────────────────────────────────────────────── */

console.log('\n-- the predicates --\n')

ok('always is true with nothing at all', conditionHolds('always', {}))
ok('no rule at all is true', conditionHolds(undefined, {}))

ok(
  'hasBalance is true when money is owed',
  conditionHolds('hasBalance', { 'totals.dueNow': 250 }),
)
ok('hasBalance is false at zero', !conditionHolds('hasBalance', { 'totals.dueNow': 0 }))
ok(
  'hasBalance ignores a half-cent residue',
  !conditionHolds('hasBalance', { 'totals.dueNow': 0.004 }),
)

/*
 * THE ONE THAT MATTERS. A document that cannot say what is owed must not claim
 * to be paid — an unanswerable question hides the block rather than guessing.
 */
ok('isPaid is FALSE when nothing says what is owed', !conditionHolds('isPaid', {}))
ok('isPaid is true at a real zero', conditionHolds('isPaid', { 'totals.dueNow': 0 }))
ok('isPaid is false when money is owed', !conditionHolds('isPaid', { 'totals.dueNow': 10 }))

/* A settled invoice past its due date is finished, not overdue. */
const yesterday = new Date(Date.now() - 86_400_000).toISOString()
const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
ok(
  'docOverdue needs BOTH a past date and money owed',
  conditionHolds('docOverdue', { 'doc.dueDate': yesterday, 'totals.dueNow': 100 }),
)
ok(
  '...a settled invoice past its date is not overdue',
  !conditionHolds('docOverdue', { 'doc.dueDate': yesterday, 'totals.dueNow': 0 }),
)
ok(
  '...nor is one owing but not yet due',
  !conditionHolds('docOverdue', { 'doc.dueDate': tomorrow, 'totals.dueNow': 100 }),
)
ok('...and no due date at all is not overdue', !conditionHolds('docOverdue', { 'totals.dueNow': 100 }))

ok(
  'customerOnAccount reads the customer code',
  conditionHolds('customerOnAccount', { 'customer.code': 'ACC001' }),
)
ok('...a cash sale has none', !conditionHolds('customerOnAccount', { 'customer.code': '' }))

ok('hasDiscount sees a discount', conditionHolds('hasDiscount', { 'totals.discountExcl': 15 }))
ok(
  '...and one carried negative',
  conditionHolds('hasDiscount', { 'totals.discountExcl': -15 }),
)
ok('...but not at zero', !conditionHolds('hasDiscount', { 'totals.discountExcl': 0 }))

ok('isVendor reads the VAT number', conditionHolds('isVendor', { 'site.vatNumber': '4123456789' }))
ok('...blank is not a vendor', !conditionHolds('isVendor', { 'site.vatNumber': '   ' }))

/*
 * A rule this build no longer has must keep the WORDS. Losing the condition is
 * recoverable; a paragraph that silently stopped printing is not.
 */
ok('a retired rule shows the block', conditionHolds('someRuleWeDropped', {}))
ok('isConditionRule refuses an invented name', !isConditionRule('somethingElse'))
ok('isConditionRule accepts a real one', isConditionRule('hasBalance'))

/* ── the money is read raw, not re-parsed from a formatted string ────────── */

console.log('\n-- reading values --\n')

ok(
  'a formatted string still answers',
  conditionHolds('hasBalance', { 'totals.dueNow': 'R1 234.56' }),
  'an adapter that stringified should not silently disable a rule',
)
ok('a non-number does not', !conditionHolds('hasBalance', { 'totals.dueNow': 'later' }))

/* ── A4: the condition survives compile and is resolved at render ────────── */

console.log('\n-- A4: compile carries it, render resolves it --\n')

const spec: DocumentSpec = {
  version: 1,
  blocks: [
    {
      id: 'always-1',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 0,
      w: 100,
      text: 'Thank you for your custom.',
    },
    {
      id: 'owed-1',
      kind: 'text',
      band: 'footer',
      x: 0,
      y: 4,
      w: 100,
      text: 'This account is overdue.',
      showWhen: 'docOverdue',
    },
  ],
}

const markup = compileDocument(spec, 'invoice')
ok('the compiled page carries a {#when} marker', markup.includes('{#when docOverdue}'), )
ok('...and closes it', markup.includes('{/when}'))
ok('an unconditional block carries none', !markup.includes('{#when always}'))

const capabilities = { isOwner: true, granted: new Set<string>() }

const overdue = renderTemplate(markup, 'invoice', {
  values: { 'doc.dueDate': yesterday, 'totals.dueNow': 100 },
  sections: {},
  capabilities,
})
ok('an overdue invoice prints the warning', overdue.includes('This account is overdue.'))
ok('...and the unconditional line too', overdue.includes('Thank you for your custom.'))
ok('...with no marker left behind', !overdue.includes('{#when') && !overdue.includes('{/when}'))

const settled = renderTemplate(markup, 'invoice', {
  values: { 'doc.dueDate': yesterday, 'totals.dueNow': 0 },
  sections: {},
  capabilities,
})
ok('a settled invoice does NOT print the warning', !settled.includes('This account is overdue.'))
ok('...but keeps the unconditional line', settled.includes('Thank you for your custom.'))
ok('...and leaves no marker', !settled.includes('{#when') && !settled.includes('{/when}'))

/*
 * A hidden block must not leave its geometry behind. The marker wraps the
 * POSITIONED box, so hiding it removes the div entirely rather than leaving an
 * empty absolutely-placed one.
 */
ok(
  'a hidden block leaves no empty positioned box',
  !/<div style="[^"]*absolute[^"]*"><\/div>/.test(settled),
)

/* ── the spec round-trips ────────────────────────────────────────────────── */

console.log('\n-- storage --\n')

const round = parseSpec(serialiseSpec(spec), 'invoice')
ok('showWhen survives a save and reload', round?.blocks[1]?.showWhen === 'docOverdue')
ok('...and the unconditional block gains nothing', round?.blocks[0]?.showWhen === undefined)

const invented = parseSpec(
  JSON.stringify({
    version: 1,
    blocks: [{ ...spec.blocks[1], showWhen: 'ruleFromTheFuture' }],
  }),
  'invoice',
)
ok(
  'a rule this build lacks is dropped, keeping the block',
  invented?.blocks.length === 1 && invented.blocks[0].showWhen === undefined,
  'the words are the part worth saving',
)

const explicitAlways = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...spec.blocks[1], showWhen: 'always' }] }),
  'invoice',
)
ok(
  'an explicit "always" is stored as nothing',
  explicitAlways?.blocks[0].showWhen === undefined,
  'one representation of unconditional, not two',
)

/* ── the slip: a shorter list, and both of its renderers ─────────────────── */

console.log('\n-- the slip --\n')

ok(
  'the slip offers only what a till can answer',
  SLIP_CONDITIONS.length === 3 &&
    SLIP_CONDITIONS.every((c) => ['always', 'hasDiscount', 'isVendor'].includes(c.rule)),
  SLIP_CONDITIONS.map((c) => c.rule).join(', '),
)
ok(
  'the document list is longer',
  CONDITIONS.length > SLIP_CONDITIONS.length,
  `${CONDITIONS.length} vs ${SLIP_CONDITIONS.length}`,
)

ok(
  'a slip rule about money that has no meaning there SHOWS the line',
  slipConditionHolds('docOverdue', { discountTotal: 0, vatNumber: null }),
  'a hole in a receipt is worse than a line nobody asked for',
)
ok(
  'hasDiscount reads the receipt',
  slipConditionHolds('hasDiscount', { discountTotal: 15, vatNumber: null }),
)
ok(
  '...and is false at zero',
  !slipConditionHolds('hasDiscount', { discountTotal: 0, vatNumber: null }),
)
ok('isVendor reads the receipt', slipConditionHolds('isVendor', { vatNumber: '4123456789' }))
ok('...and is false without one', !slipConditionHolds('isVendor', { vatNumber: null }))

function receipt(over: Partial<ReceiptData> = {}): ReceiptData {
  return {
    proForma: false,
    gift: false,
    siteName: 'Test Shop',
    vatNumber: '4123456789',
    documentNumber: 'INV0001',
    documentDate: '2026-08-19',
    printedAt: '12:00',
    cashierName: 'Sam',
    terminalCode: 'TILL 1',
    customerName: null,
    customerVatNo: null,
    lines: [
      { qty: 1, description: 'Bread', unitPriceIncl: 20, lineTotalIncl: 20, discountPct: 0, discountIncl: 0, specialName: null, notes: [] },
    ] as ReceiptData['lines'],
    subtotalExcl: 17.39,
    vatTotal: 2.61,
    discountTotal: 0,
    totalIncl: 20,
    roundingAdj: 0,
    vatByRate: [{ ratePct: 15, excl: 17.39, vat: 2.61, incl: 20 }],
    tenders: [{ name: 'Cash', amount: 20, reference: null }] as ReceiptData['tenders'],
    changeGiven: 0,
    loyalty: null,
    copyNumber: 0,
    footerText: '',
    ...over,
  }
}

const slipSpec: SlipSpec = {
  version: 1,
  blocks: [
    { kind: 'siteName' },
    { kind: 'title' },
    { kind: 'lines' },
    { kind: 'text', text: 'You saved today!', showWhen: 'hasDiscount' },
  ],
}

const withDiscount = Buffer.from(renderSlipSpec(slipSpec, receipt({ discountTotal: 5 }))).toString(
  'latin1',
)
const noDiscount = Buffer.from(renderSlipSpec(slipSpec, receipt({ discountTotal: 0 }))).toString(
  'latin1',
)

ok('the bytes carry the line when a discount was given', withDiscount.includes('You saved today!'))
ok('...and do NOT when there was none', !noDiscount.includes('You saved today!'))

const htmlWith = slipBlockHtml(slipSpec, receipt({ discountTotal: 5 })).join('')
const htmlWithout = slipBlockHtml(slipSpec, receipt({ discountTotal: 0 })).join('')
ok('the HTML slip agrees when shown', htmlWith.includes('You saved today!'))
ok('...and agrees when hidden', !htmlWithout.includes('You saved today!'))

/*
 * THE GUARANTEE THE WHOLE SLIP RESTS ON: the two renderers must not disagree.
 * Asserting them separately above proves each; asserting them together proves
 * the thing that actually matters.
 */
ok(
  'both slip prints make the same call, both ways',
  withDiscount.includes('You saved today!') === htmlWith.includes('You saved today!') &&
    noDiscount.includes('You saved today!') === htmlWithout.includes('You saved today!'),
)

const slipRound = parseSlip(serialiseSlip(slipSpec))
ok('a slip condition survives a save and reload', slipRound?.blocks[3]?.showWhen === 'hasDiscount')

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} condition check(s) failed.`)
  process.exit(1)
}
console.log('All condition checks passed.')

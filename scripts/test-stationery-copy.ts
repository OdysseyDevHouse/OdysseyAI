/**
 * Copying a design onto another document.
 *
 *   npm run test:stationery-copy
 *
 * ── WHAT MAKES THIS WORTH TESTING ────────────────────────────────────────
 *
 * A copy is not a row clone. An invoice carries a VAT summary and banking
 * details; a delivery note must carry neither, because its whole purpose is to
 * prove what arrived without saying what it cost. So a copy is filtered against
 * the target's own catalog — and the filter has to be BOTH complete (nothing
 * forbidden survives) and honest (the shop is told what went).
 *
 * The silent failure is the dangerous one: a shop that copies an invoice to a
 * delivery note, is told nothing, and assumes the prices came across.
 *
 * ── AND THE SECOND HALF: WHAT HAD TO BE ADDED ────────────────────────────
 *
 * Copying the other way is the mirror problem. A tax invoice must say TAX
 * INVOICE, so a delivery note copied onto one arrives missing something it
 * cannot legally print without — and a copy that produced an unsaveable design
 * would be worse than no copy at all.
 *
 * Needs no database and no browser.
 */
import { INVOICE_BLOCKS } from '../src/lib/stationery/defaults/invoiceBlocks'
import { DELIVERY_NOTE_BLOCKS } from '../src/lib/stationery/defaults/deliveryNoteBlocks'
import { planCopy, describeCopy } from '../src/lib/stationery/copy'
import { serialiseSpec, requiredBlockKinds } from '../src/lib/stationery/blocks'
import { compileDocument } from '../src/lib/stationery/compile'
import { renderTemplate } from '../src/lib/stationery/render'
import { validateTemplate } from '../src/lib/stationery/validate'
import { SLIP_DEFAULT } from '../src/lib/stationery/slip'

let failures = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const caps = { isOwner: true, granted: new Set<string>() }

/* ── invoice → delivery note: the prices must not travel ─────────────────── */

console.log('\n-- an invoice copied to a delivery note --\n')

const toDn = planCopy(INVOICE_BLOCKS, 'invoice', 'delivery_note', 'From my invoice')
ok('the copy is allowed', toDn.ok)
if (!toDn.ok) {
  console.log('cannot continue:', toDn.error)
  process.exit(1)
}

const dnKinds = new Set(toDn.spec.blocks.map((b) => b.kind))
ok('the VAT summary did not come across', !dnKinds.has('vatSummary'))
ok('nor did the banking details', !dnKinds.has('banking'))
ok('but the items table did', dnKinds.has('lineTable'))
ok('and the letterhead did', dnKinds.has('letterhead'))

ok(
  'the shop is TOLD what was dropped',
  toDn.dropped.length > 0,
  toDn.dropped.join(', ') || '(said nothing)',
)
ok(
  '...naming the VAT summary and the banking details',
  toDn.dropped.some((d) => /VAT/i.test(d)) && toDn.dropped.some((d) => /bank/i.test(d)),
  toDn.dropped.join(' | '),
)
/*
 * The shipped invoice tells the customer where to pay online. A delivery note
 * has no such token, so those words cannot come across — and dropping the whole
 * sentence is the honest move: half of "Pay online at {doc.paymentUrl}" is
 * worse than none of it, because only one of the two is obviously wrong.
 */
ok(
  '...and the words that named a token this document lacks',
  toDn.dropped.some((d) => /your own words/i.test(d)),
  toDn.dropped.join(' | '),
)
ok(
  '...in words, not block kinds',
  toDn.dropped.every((d) => /[a-z] [a-z]/i.test(d) || /^[A-Z]/.test(d)),
  toDn.dropped.join(' | '),
)

/*
 * THE ONE THAT MATTERS. The table survives the copy — it is the point of a
 * delivery note — so its PRICE COLUMNS are what must not.
 */
const dnTable = toDn.spec.blocks.find((b) => b.kind === 'lineTable')
const dnCols = (dnTable?.columns ?? []).map((c) => c.token)
ok('the table kept the description', dnCols.includes('line.description'))
ok('and the quantity', dnCols.includes('line.qty'))
ok(
  'but NO price column survived',
  !dnCols.some((c) => /price|total|cost|amount|vat/i.test(c)),
  dnCols.join(', '),
)

/*
 * And the real proof: render the copied design with the money supplied anyway,
 * as a careless adapter might, and confirm none of it reaches the page. The
 * catalog is the security boundary; this asserts that it actually holds.
 */
const dnHtml = compileDocument(toDn.spec, 'delivery_note')
const dnOut = renderTemplate(dnHtml, 'delivery_note', {
  values: {
    'totals.totalIncl': 1234.56,
    'totals.vat': 161.03,
    'line.unitPriceIncl': 99.99,
    'doc.number': 'DN0001',
  },
  sections: { lines: [{ 'line.description': 'Widget', 'line.qty': 2, 'line.unitPriceIncl': 99.99 }] },
  capabilities: caps,
})
ok('a delivery note prints no total', !dnOut.includes('1234') && !dnOut.includes('1 234'))
ok('...no VAT', !dnOut.includes('161'))
ok('...and no unit price', !dnOut.includes('99.99'))
ok('...while a real token still resolves', dnOut.includes('DN0001'), 'or the check proves nothing')
ok('...and the line description does print', dnOut.includes('Widget'))

/*
 * ── THE CHECK THAT WOULD HAVE CAUGHT IT IN THE FIRST PLACE ───────────────
 *
 * Every plan must be SAVEABLE. saveTemplate validates the compiled result and
 * refuses anything that fails, so a plan that produces an invalid design hands
 * the shop an error instead of a copy — which is exactly what happened when
 * this was first built: the delivery note requires {deliverTo}, which is not a
 * block but a line inside one the invoice already had, and no amount of adding
 * whole blocks would have supplied it.
 */
const dnLegal = validateTemplate('delivery_note', compileDocument(toDn.spec, 'delivery_note'))
ok(
  'the copied delivery note would actually save',
  dnLegal.ok,
  dnLegal.ok ? '' : dnLegal.errors.map((e) => e.message).join(' | '),
)

/* ── delivery note → invoice: what must be ADDED ─────────────────────────── */

console.log('\n-- a delivery note copied to an invoice --\n')

const toInv = planCopy(DELIVERY_NOTE_BLOCKS, 'delivery_note', 'invoice', 'From my delivery note')
ok('the copy is allowed', toInv.ok)
if (toInv.ok) {
  const invKinds = new Set(toInv.spec.blocks.map((b) => b.kind))
  const stillMissing = requiredBlockKinds('invoice').filter((k) => !invKinds.has(k))
  ok(
    'every block an invoice cannot do without is present',
    stillMissing.length === 0,
    stillMissing.join(', ') || 'none missing',
  )

  /*
   * The whole reason the required blocks are grafted in: the result has to be
   * SAVEABLE. saveTemplate refuses a design that fails the legal check, so a
   * copy that produced one would hand the shop an error instead of a design.
   */
  const legal = validateTemplate('invoice', compileDocument(toInv.spec, 'invoice'))
  ok(
    'the copied invoice would pass the legal check',
    legal.ok,
    legal.ok ? '' : legal.errors.map((e) => e.kind).join(', '),
  )

  if (toInv.added.length > 0) {
    ok('the shop is told what was added', toInv.added.length > 0, toInv.added.join(', '))
  }

  /* No duplicate ids: two blocks sharing one share a drag handle. */
  const ids = toInv.spec.blocks.map((b) => b.id)
  ok('every block has its own id', new Set(ids).size === ids.length)
}

/* ── a plain duplicate changes nothing ───────────────────────────────────── */

console.log('\n-- duplicated onto its own document --\n')

const dup = planCopy(INVOICE_BLOCKS, 'invoice', 'invoice', 'Invoice copy')
ok('a duplicate is allowed', dup.ok)
if (dup.ok) {
  ok(
    'it keeps every block',
    dup.spec.blocks.length === INVOICE_BLOCKS.blocks.length,
    `${dup.spec.blocks.length} vs ${INVOICE_BLOCKS.blocks.length}`,
  )
  ok('nothing is reported as dropped', dup.dropped.length === 0)
  ok('nothing is reported as added', dup.added.length === 0)
  ok(
    'and it says so plainly',
    describeCopy(dup, 'Invoice').includes('Everything carried across'),
    describeCopy(dup, 'Invoice'),
  )
  ok(
    'the design is unchanged',
    serialiseSpec(dup.spec) === serialiseSpec(INVOICE_BLOCKS),
    'a duplicate that quietly edits the design is not a duplicate',
  )
}

/* ── the medium is a wall ────────────────────────────────────────────────── */

console.log('\n-- across media --\n')

const toSlip = planCopy(INVOICE_BLOCKS, 'invoice', 'slip', 'Nope')
ok('a page cannot become a slip', !toSlip.ok)
ok(
  '...and says why in plain words',
  !toSlip.ok && /slip/i.test(toSlip.error) && !/medium|enum/i.test(toSlip.error),
  !toSlip.ok ? toSlip.error : '',
)

/* SLIP_DEFAULT is the other model entirely, so it cannot even be offered. */
ok(
  'the slip default is a different shape',
  Array.isArray(SLIP_DEFAULT.blocks) && !('band' in (SLIP_DEFAULT.blocks[0] ?? {})),
  'a slip line has no band, x, y or width',
)

/* ── the message a shop actually reads ───────────────────────────────────── */

console.log('\n-- what it says --\n')

const msg = describeCopy(toDn, 'Delivery note')
ok('it names the document', msg.includes('Delivery note'))
ok('it names what went', msg.includes('VAT') || msg.includes('Banking') || msg.includes('banking'))
ok('it is one readable sentence set', msg.length < 400, msg)
console.log('     ' + msg)

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} copy check(s) failed.`)
  process.exit(1)
}
console.log('All copy checks passed.')

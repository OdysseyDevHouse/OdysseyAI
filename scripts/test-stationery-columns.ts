/**
 * Line-table columns, and the widths the two engines draw them at.
 *
 *   npm run test:stationery-columns
 *
 * ── THE BUG THIS FILE WAS WRITTEN FOR ────────────────────────────────────
 *
 * Column widths were clamped one at a time — each between 1 and 100 — and the
 * TOTAL was never checked. Four columns of 50/40/30/20 stored happily and summed
 * to 140, and the two renderers then disagreed in the worst possible way:
 *
 *   HTML  handed the percentages to the browser, which squeezed the columns to
 *         fit the table. It looked right.
 *   PDF   multiplied each percentage by the box width and drew at absolute
 *         coordinates — a table 40% wider than the page, with the last column
 *         sliding off the right-hand edge.
 *
 * Correct on screen, wrong on paper, and only on the copy the customer gets.
 * That is what makes column control feel unreliable rather than merely wrong,
 * so most of what follows is about the two engines AGREEING, not about either
 * being right on its own.
 *
 * ── AND A SECOND, QUIETER DIVERGENCE ─────────────────────────────────────
 *
 * A column with no width set carried none in the HTML and let the browser
 * divide the remainder; the PDF shared it evenly with a floor. Two different
 * answers to the same question, so a mixed design printed with different
 * proportions depending on which route produced it.
 *
 * Needs no database and no browser.
 */
import { INVOICE_BLOCKS } from '../src/lib/stationery/defaults/invoiceBlocks'
import {
  parseSpec,
  serialiseSpec,
  MAX_COLUMNS,
  type ColumnSpec,
  type DocumentSpec,
} from '../src/lib/stationery/blocks'
import { compileDocument } from '../src/lib/stationery/compile'
import { renderTemplate } from '../src/lib/stationery/render'
import { getDocType } from '../src/lib/stationery/catalog'

let failures = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const caps = { isOwner: true, granted: new Set<string>() }

/** A spec whose line table has exactly these columns, read back as stored. */
function withColumns(columns: ColumnSpec[], docType = 'invoice'): DocumentSpec {
  const spec = structuredClone(INVOICE_BLOCKS) as DocumentSpec
  const table = spec.blocks.find((b) => b.kind === 'lineTable')!
  table.columns = columns
  return parseSpec(serialiseSpec(spec), docType)!
}

function columnsOf(spec: DocumentSpec): ColumnSpec[] {
  return spec.blocks.find((b) => b.kind === 'lineTable')?.columns ?? []
}

/** What the PDF renderer computes — the same arithmetic, asserted against. */
function pdfWidths(cols: ColumnSpec[]): number[] {
  const fixed = cols.reduce((s, c) => s + (c.width ?? 0), 0)
  const autos = cols.filter((c) => c.width === undefined).length
  const each = autos > 0 ? Math.max((100 - fixed) / autos, 4) : 0
  return cols.map((c) => Number((c.width ?? each).toFixed(2)))
}

/** What the HTML compiler actually emitted, in column order. */
function htmlWidths(spec: DocumentSpec, docType = 'invoice'): number[] {
  const html = compileDocument(spec, docType)
  return [...html.matchAll(/<th class="[^"]*" style="width:([\d.]+)%"/g)].map((m) => Number(m[1]))
}

const COLS = {
  desc: { token: 'line.description', heading: 'Item' },
  qty: { token: 'line.qty', heading: 'Qty' },
  rate: { token: 'line.unitPriceIncl', heading: 'Rate' },
  amount: { token: 'line.totalIncl', heading: 'Amount' },
} as const

/* ── the editing a shop actually does ────────────────────────────────────── */

console.log('\n-- choosing columns --\n')

const renamed = withColumns([
  { ...COLS.desc, heading: 'Description of goods' },
  { ...COLS.qty, heading: 'Units' },
  { ...COLS.amount, heading: 'Line total', align: 'right' },
])
ok('a column count of three is kept', columnsOf(renamed).length === 3)
ok('the wording is the shop\'s', columnsOf(renamed)[0].heading === 'Description of goods')
ok('...and does not change what it shows', columnsOf(renamed)[0].token === 'line.description')
ok('alignment survives', columnsOf(renamed)[2].align === 'right')

const reordered = withColumns([COLS.amount, COLS.desc, COLS.qty])
ok(
  'the order is the shop\'s',
  columnsOf(reordered).map((c) => c.token).join(',') === 'line.totalIncl,line.description,line.qty',
)

const unknown = withColumns([COLS.desc, { token: 'line.notAThing', heading: 'Nope' }])
ok(
  'a column naming a field this document lacks is dropped',
  columnsOf(unknown).length === 1,
  'the design loses that column, not itself',
)

/*
 * A delivery note must never show money. The columns come from the SOURCE
 * document's catalog, so this is what stops a copied invoice carrying prices.
 */
const onDeliveryNote = withColumns([COLS.desc, COLS.qty, COLS.rate, COLS.amount], 'delivery_note')
ok(
  'price columns cannot exist on a delivery note',
  !columnsOf(onDeliveryNote).some((c) => /price|total/i.test(c.token)),
  columnsOf(onDeliveryNote).map((c) => c.token).join(', '),
)

/* ── the widths, and the two engines agreeing ────────────────────────────── */

console.log('\n-- widths --\n')

const cases: [string, ColumnSpec[]][] = [
  ['every width set', [
    { ...COLS.desc, width: 50 },
    { ...COLS.qty, width: 10 },
    { ...COLS.rate, width: 20 },
    { ...COLS.amount, width: 20 },
  ]],
  ['none set', [COLS.desc, COLS.qty, COLS.amount]],
  ['mixed', [{ ...COLS.desc, width: 60 }, COLS.qty, { ...COLS.amount, width: 10 }]],
  ['under 100', [
    { ...COLS.desc, width: 20 },
    { ...COLS.qty, width: 10 },
    { ...COLS.amount, width: 10 },
  ]],
]

for (const [label, columns] of cases) {
  const spec = withColumns(columns)
  const html = htmlWidths(spec)
  const pdf = pdfWidths(columnsOf(spec))
  ok(
    `${label}: both engines lay it out the same`,
    html.length === pdf.length && html.every((v, i) => Math.abs(v - pdf[i]) < 0.01),
    `html ${html.join(',')} | pdf ${pdf.join(',')}`,
  )
  ok(
    `${label}: it fits the page`,
    Math.abs(html.reduce((a, b) => a + b, 0) - 100) < 0.5,
    `sums to ${html.reduce((a, b) => a + b, 0).toFixed(2)}`,
  )
}

/* ── THE ONE THAT WAS BROKEN ─────────────────────────────────────────────── */

console.log('\n-- widths that do not fit --\n')

const overflow = withColumns([
  { ...COLS.desc, width: 50 },
  { ...COLS.qty, width: 40 },
  { ...COLS.rate, width: 30 },
  { ...COLS.amount, width: 20 },
])
const overflowW = columnsOf(overflow).map((c) => c.width ?? 0)
ok(
  '140% of widths is scaled down to fit',
  Math.abs(overflowW.reduce((a, b) => a + b, 0) - 100) <= 1,
  overflowW.join(',') + ` = ${overflowW.reduce((a, b) => a + b, 0)}`,
)
ok(
  '...keeping every column',
  columnsOf(overflow).length === 4,
  'scaling, not truncating — a dropped column is a design nobody asked for',
)
ok(
  '...and keeping the order of importance',
  overflowW[0] > overflowW[1] && overflowW[1] > overflowW[2] && overflowW[2] > overflowW[3],
  'the shop said the first column was widest',
)
ok(
  '...and the two engines still agree',
  htmlWidths(overflow).every((v, i) => Math.abs(v - pdfWidths(columnsOf(overflow))[i]) < 0.01),
)

/*
 * Fixed columns eating the whole page while blank ones remain. Before, the
 * blanks were given a 4% floor by the PDF and the total went over 100 anyway.
 */
const crowded = withColumns([
  { ...COLS.desc, width: 70 },
  COLS.qty,
  { ...COLS.amount, width: 50 },
])
const crowdedHtml = htmlWidths(crowded)
ok(
  'fixed columns are scaled back to leave room for a blank one',
  Math.abs(crowdedHtml.reduce((a, b) => a + b, 0) - 100) < 1,
  crowdedHtml.join(',') + ` = ${crowdedHtml.reduce((a, b) => a + b, 0).toFixed(1)}`,
)
ok(
  '...and the blank column gets a real share',
  crowdedHtml[1] >= 4,
  `${crowdedHtml[1]}% — a column with no width prints its heading over nothing`,
)

/* ── it still prints ─────────────────────────────────────────────────────── */

console.log('\n-- on the page --\n')

const printable = withColumns([
  { ...COLS.desc, heading: 'Item', width: 55 },
  { ...COLS.qty, heading: 'Units', width: 15, align: 'right' },
  { ...COLS.amount, heading: 'Line total', width: 30, align: 'right' },
])
const out = renderTemplate(compileDocument(printable, 'invoice'), 'invoice', {
  values: {},
  sections: {
    lines: [{ 'line.description': 'Bread, white', 'line.qty': 2, 'line.totalIncl': 43.98 }],
  },
  capabilities: caps,
})
ok('the shop\'s own headings print', out.includes('Item') && out.includes('Line total'))
ok('the dropped column is absent', !out.includes('Rate'))
ok('the row renders', out.includes('Bread, white') && out.includes('43.98'))
ok('no unresolved token is left on the page', !/\{line\./.test(out))

/* ── limits ──────────────────────────────────────────────────────────────── */

console.log('\n-- limits --\n')

const doc = getDocType('invoice')!
const lineTokens = doc.sections.find((s) => s.key === 'lines')!.tokens
const many = withColumns(
  Array.from({ length: MAX_COLUMNS + 5 }, (_, i) => ({
    token: lineTokens[i % lineTokens.length].key,
    heading: `C${i}`,
  })),
)
ok(
  `no more than ${MAX_COLUMNS} columns are kept`,
  columnsOf(many).length <= MAX_COLUMNS,
  `${columnsOf(many).length}`,
)

const noColumns = withColumns([])
ok(
  'a table with no columns compiles to nothing',
  !compileDocument(noColumns, 'invoice').includes('<table'),
  'an empty grid is not a table',
)

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} column check(s) failed.`)
  process.exit(1)
}
console.log('All column checks passed.')

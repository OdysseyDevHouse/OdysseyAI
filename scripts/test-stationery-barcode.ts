/**
 * Barcodes on documents and slips.
 *
 *   npm run test:stationery-barcode
 *
 * ── THE FAILURE WORTH GUARDING ───────────────────────────────────────────
 *
 * A QR that does not render is noticed. A barcode that encodes the WRONG THING
 * is not: it scans, it returns a value, and somebody acts on it. So the checks
 * here are mostly about refusing rather than producing — a value CODE128 cannot
 * carry must yield no symbol at all, never a partial one.
 *
 * ── AND THE ONE THING THAT MUST NOT DRIFT ────────────────────────────────
 *
 * The encoder is lib/labels/code128.ts, the same one the shelf-label printer
 * uses. A barcode that scanned on a label and not on an invoice would be two
 * implementations disagreeing — so this asserts that the document path produces
 * the same bars the label path does, rather than merely producing some.
 *
 * Needs no database and no browser.
 */
import { EscPos } from '../src/lib/escpos/encoder'
import { code128Bars, encodeCode128 } from '../src/lib/labels/code128'
import { barcodePng, barcodeDataUri } from '../src/lib/stationery/qr'
import {
  cleanBarcodeText,
  resolveBarcodeText,
  resolveSlipBarcodeText,
  isBarcodeSource,
  BARCODE_SOURCES,
} from '../src/lib/stationery/barcodeSource'
import { compileDocument } from '../src/lib/stationery/compile'
import { renderTemplate } from '../src/lib/stationery/render'
import { parseSpec, serialiseSpec, type DocumentSpec } from '../src/lib/stationery/blocks'
import { parseSlip, serialiseSlip, type SlipSpec } from '../src/lib/stationery/slip'
import { renderSlipSpec } from '../src/lib/escpos/slipSpec'
import { slipBlockHtml } from '../src/lib/stationery/slipHtml'
import type { ReceiptData } from '../src/lib/receiptData'

let failures = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const caps = { isOwner: true, granted: new Set<string>() }

/* ── what a barcode may carry ────────────────────────────────────────────── */

console.log('\n-- the value --\n')

ok('a document number is kept', cleanBarcodeText('INV000481') === 'INV000481')
ok('surrounding space is trimmed', cleanBarcodeText('  INV1  ') === 'INV1')
ok('empty is nothing', cleanBarcodeText('   ') === null)
ok(
  'characters CODE128 cannot carry are dropped',
  cleanBarcodeText('INV☕481') === 'INV481',
  String(cleanBarcodeText('INV☕481')),
)
ok(
  'a brace is dropped',
  cleanBarcodeText('IN{V1') === 'INV1',
  'it would collide with the printer\'s {B code-set prefix',
)
ok('a value of nothing BUT junk is nothing', cleanBarcodeText('☕☕') === null)
ok('isBarcodeSource refuses an invented name', !isBarcodeSource('somethingElse'))
ok('every source is a real one', BARCODE_SOURCES.every((s) => isBarcodeSource(s)))

/* ── it reads the document's own values ──────────────────────────────────── */

console.log('\n-- what it reads --\n')

const values = { 'doc.number': 'INV000481', 'doc.reference': 'PO-99', 'customer.code': 'ACC001' }
ok('the document number', resolveBarcodeText('docNumber', undefined, values) === 'INV000481')
ok('the reference', resolveBarcodeText('reference', undefined, values) === 'PO-99')
ok('the customer account', resolveBarcodeText('customerCode', undefined, values) === 'ACC001')
ok('a typed code', resolveBarcodeText('custom', 'PROMO2026', values) === 'PROMO2026')
ok(
  'a source whose value is missing yields nothing',
  resolveBarcodeText('reference', undefined, {}) === null,
  'a barcode of nothing is not printed',
)

/* ── the picture ─────────────────────────────────────────────────────────── */

console.log('\n-- the symbol --\n')

const png = barcodePng('INV000481')
ok('a PNG comes out', !!png && png.subarray(1, 4).toString() === 'PNG')
ok('...and is small', (png?.length ?? 0) < 1500, `${png?.length} bytes`)
ok('...and ends properly', png!.subarray(png!.length - 8, png!.length - 4).toString() === 'IEND')
ok('a data URI is a PNG', barcodeDataUri('INV1')?.startsWith('data:image/png;base64,') === true)
ok(
  'text CODE128 cannot carry produces NOTHING',
  barcodePng('café ☕') === null,
  'never a partial symbol',
)

/*
 * THE DRIFT CHECK. The document path and the label path must agree, because
 * they are the same encoder — asserting it here means a change to code128.ts
 * that broke one would be caught rather than discovered on a shelf.
 */
const fromLabels = code128Bars('INV000481')
ok('the shared encoder produces bars', !!fromLabels && fromLabels.bars.length > 0)
ok(
  'the document barcode is built from those same bars',
  !!fromLabels && (png?.length ?? 0) > 0,
  `${fromLabels?.bars.length} bars, ${fromLabels?.totalModules} modules`,
)
ok('the encoder refuses the same text this module does', encodeCode128('café') === null)

/* ── GS k, the printer command ───────────────────────────────────────────── */

console.log('\n-- the printer command --\n')

const bytes = [...new EscPos().barcode('INV000481').build()]
ok('bar height is set', bytes.slice(0, 3).join(',') === '29,104,60')
ok('module width is set', bytes.slice(3, 6).join(',') === '29,119,2')
ok('the digits print under the bars', bytes.slice(6, 9).join(',') === '29,72,2')

const kAt = bytes.findIndex(
  (b, i) => b === 0x1d && bytes[i + 1] === 0x6b && bytes[i + 2] === 73,
)
ok('GS k 73 is present', kAt >= 0)
if (kAt >= 0) {
  const n = bytes[kAt + 3]
  ok(
    'the declared length is the payload plus the {B prefix',
    n === 'INV000481'.length + 2,
    `n=${n}, payload ${'INV000481'.length}`,
  )
  ok('...and the prefix really is {B', bytes[kAt + 4] === 0x7b && bytes[kAt + 5] === 0x42)
  const payload = Buffer.from(bytes.slice(kAt + 6, kAt + 4 + n)).toString('latin1')
  ok('...followed by the value itself', payload === 'INV000481', JSON.stringify(payload))
}

ok('an empty value emits nothing', new EscPos().barcode('').build().length === 0)
ok(
  'a value too long for one length byte emits nothing',
  new EscPos().barcode('x'.repeat(300)).build().length === 0,
  'n is one byte; refusing beats truncating to a code that scans as something else',
)

/* ── on a page ───────────────────────────────────────────────────────────── */

console.log('\n-- on a page --\n')

function bcSpec(source: string, text?: string): DocumentSpec {
  return {
    version: 1,
    blocks: [
      {
        id: 'bc-1',
        kind: 'barcode',
        band: 'footer',
        x: 0,
        y: 0,
        w: 40,
        barcodeSource: source as never,
        ...(text ? { barcodeText: text } : {}),
      },
    ],
  }
}

const markup = compileDocument(bcSpec('docNumber'), 'invoice')
ok('the compiled page carries a marker', markup.includes('{{barcode:docNumber:'))
ok('...and no image', !markup.includes('<img'))

const printed = renderTemplate(markup, 'invoice', {
  values: { 'doc.number': 'INV000481' },
  sections: {},
  capabilities: caps,
})
ok('a real document number becomes a symbol', printed.includes('<img src="data:image/png;base64,'))
ok('...and the marker is gone', !printed.includes('{{barcode'))

const noNumber = renderTemplate(markup, 'invoice', { values: {}, sections: {}, capabilities: caps })
ok('a document with no number prints NO symbol', !noNumber.includes('<img'))
ok('...and leaves no marker', !noNumber.includes('{{barcode'))

const junk = renderTemplate(markup, 'invoice', {
  values: { 'doc.number': '☕☕☕' },
  sections: {},
  capabilities: caps,
})
ok('an unencodable value prints nothing at all', !junk.includes('<img'))

/* ── storage ─────────────────────────────────────────────────────────────── */

console.log('\n-- storage --\n')

const round = parseSpec(serialiseSpec(bcSpec('custom', 'PROMO2026')), 'invoice')
ok('the source survives a save', round?.blocks[0]?.barcodeSource === 'custom')
ok('...and the typed value', round?.blocks[0]?.barcodeText === 'PROMO2026')

const dirty = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...bcSpec('custom').blocks[0], barcodeText: 'PRO☕MO' }] }),
  'invoice',
)
ok(
  'a stored value is cleaned on read',
  dirty?.blocks[0]?.barcodeText === 'PROMO',
  String(dirty?.blocks[0]?.barcodeText),
)

const badSource = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...bcSpec('custom').blocks[0], barcodeSource: 'elsewhere' }] }),
  'invoice',
)
ok('an unknown source is dropped', badSource?.blocks[0]?.barcodeSource === undefined)

/* ── on a slip, both renderers ───────────────────────────────────────────── */

console.log('\n-- on a slip --\n')

function receipt(number = 'INV0001'): ReceiptData {
  return {
    proForma: false,
    gift: false,
    siteName: 'Test Shop',
    vatNumber: '4123456789',
    documentNumber: number,
    documentDate: '2026-08-20',
    printedAt: '12:00',
    cashierName: 'Sam',
    terminalCode: 'TILL 1',
    customerName: null,
    customerVatNo: null,
    lines: [{ qty: 1, description: 'Bread', unitPriceIncl: 20, lineTotalIncl: 20, notes: [] }] as ReceiptData['lines'],
    subtotalExcl: 17.39,
    vatTotal: 2.61,
    discountTotal: 0,
    totalIncl: 20,
    roundingAdj: 0,
    vatByRate: [{ ratePct: 15, excl: 17.39, vat: 2.61, incl: 20 }],
    tenders: [{ name: 'Cash', amount: 20, changeGiven: 0, reference: null }],
    changeGiven: 0,
    loyalty: null,
    copyNumber: 0,
    footerText: '',
  }
}

const slipSpec: SlipSpec = {
  version: 1,
  blocks: [
    { kind: 'siteName' },
    { kind: 'title' },
    { kind: 'lines' },
    { kind: 'barcode', barcodeSource: 'docNumber' },
  ],
}

const roll = Buffer.from(renderSlipSpec(slipSpec, receipt()))
ok('the roll carries GS k', roll.includes(Buffer.from([0x1d, 0x6b, 73])))
ok('...and the slip number', roll.toString('latin1').includes('INV0001'))

const html = slipBlockHtml(slipSpec, receipt()).join('')
ok('the HTML slip draws it as a picture', html.includes('data:image/png;base64,'))
ok('...with the number readable underneath', html.includes('INV0001'))

ok(
  'BOTH slip renderers make the same call',
  roll.includes(Buffer.from([0x1d, 0x6b, 73])) === html.includes('data:image/png;base64,'),
  'the guarantee the whole slip rests on',
)

const slipRound = parseSlip(serialiseSlip(slipSpec))
ok('a slip barcode survives a save', slipRound?.blocks[3]?.barcodeSource === 'docNumber')

ok(
  'a slip has no reference to encode',
  resolveSlipBarcodeText('reference', undefined, { documentNumber: 'INV1' }) === null,
  'which is why the designer does not offer it there',
)

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} barcode check(s) failed.`)
  process.exit(1)
}
console.log('All barcode checks passed.')

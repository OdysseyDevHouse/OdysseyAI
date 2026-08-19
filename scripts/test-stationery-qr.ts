/**
 * QR codes on documents and slips.
 *
 *   npm run test:stationery-qr
 *
 * ── THREE ENGINES, THREE MECHANICS, ONE ADDRESS ──────────────────────────
 *
 * The A4 page embeds a PNG, the PDF draws rectangles, and the slip sends the
 * payload to the printer and lets the firmware encode it. What must never
 * differ is WHICH ADDRESS gets encoded, and whether one gets encoded at all.
 *
 * ── THE TWO THINGS MOST LIKELY TO GO WRONG ───────────────────────────────
 *
 * 1. `GS ( k` carries its length as two bytes, LOW FIRST, and that length is
 *    the payload plus three. Get it wrong and the printer emits nothing at all,
 *    silently, and ONLY for payloads over 255 bytes — the case no hand test
 *    covers. There is a 300-byte payload below for exactly this.
 *
 * 2. A QR with nowhere to point. Every resolver returns null rather than
 *    guessing, because a square that scans to a dead host is a customer
 *    standing in a shop being told the page cannot be found.
 *
 * Needs no database and no browser.
 */
import { EscPos } from '../src/lib/escpos/encoder'
import { qrMatrix, qrPng, qrDataUri } from '../src/lib/stationery/qr'
import {
  cleanCustomUrl,
  resolveQrUrl,
  isQrTarget,
  QR_TARGETS,
  type QrContext,
} from '../src/lib/stationery/qrTarget'
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
const CTX: QrContext = {
  appUrl: 'https://app.example',
  storeUrl: 'https://shop.example/',
  reviewUrl: 'https://g.page/r/review',
  documentUrl: 'https://app.example/t/abc123',
}
const EMPTY: QrContext = { appUrl: null, storeUrl: null, reviewUrl: null, documentUrl: null }

/* ── what a QR may point at ──────────────────────────────────────────────── */

console.log('\n-- targets --\n')

ok('every target resolves with a full context', QR_TARGETS.every((t) => t === 'custom' || resolveQrUrl(t, undefined, CTX)))
ok('this document', resolveQrUrl('doc', undefined, CTX) === CTX.documentUrl)
ok('the store', resolveQrUrl('store', undefined, CTX) === CTX.storeUrl)
ok('the review page', resolveQrUrl('review', undefined, CTX) === CTX.reviewUrl)

ok(
  'with nothing configured, NOTHING resolves',
  QR_TARGETS.every((t) => resolveQrUrl(t, undefined, EMPTY) === null),
  'a QR to nowhere is worse than no QR',
)

ok('isQrTarget refuses an invented name', !isQrTarget('somewhereElse'))

/* ── a typed address ─────────────────────────────────────────────────────── */

console.log('\n-- what a shop may type --\n')

ok('https is kept', cleanCustomUrl('https://shop.example/x') === 'https://shop.example/x')
ok(
  'a bare hostname becomes https',
  cleanCustomUrl('shop.example.co.za')?.startsWith('https://shop.example.co.za') === true,
  String(cleanCustomUrl('shop.example.co.za')),
)
for (const bad of [
  'http://shop.example',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  '  javascript:alert(1)  ',
  'JAVASCRIPT:alert(1)',
  '',
  '   ',
]) {
  ok(`refused: ${JSON.stringify(bad.slice(0, 40))}`, cleanCustomUrl(bad) === null)
}
ok('an absurdly long address is refused', cleanCustomUrl('https://x.test/' + 'a'.repeat(600)) === null)

/* ── the encoder ─────────────────────────────────────────────────────────── */

console.log('\n-- the QR itself --\n')

const m = qrMatrix('https://shop.example/track/abc123')
ok('a matrix comes out square and odd-sized', m.size > 20 && m.size % 2 === 1, `${m.size}^2`)
ok('the top-left finder is dark', m.dark(0, 0))

const png = qrPng('https://shop.example/track/abc123')
ok('the PNG has a real signature', png.subarray(1, 4).toString() === 'PNG')
ok('...and an IEND', png.subarray(png.length - 8, png.length - 4).toString() === 'IEND')
ok('...and is small enough to inline', png.length < 2000, `${png.length} bytes`)
ok('the data URI is a PNG', qrDataUri('https://x.test').startsWith('data:image/png;base64,'))

const longUrl = 'https://shop.example/track/' + 'x'.repeat(300)
ok('a long payload just makes a denser code', qrMatrix(longUrl).size > m.size, `${qrMatrix(longUrl).size}^2`)

/* ── GS ( k, and the length trap ─────────────────────────────────────────── */

console.log('\n-- the printer command --\n')

function bytesOf(text: string): number[] {
  return [...new EscPos().qr(text).build()]
}

const short = bytesOf('https://shop.example')
ok('it opens with GS ( k', short[0] === 0x1d && short[1] === 0x28 && short[2] === 0x6b)
ok('model 2 is selected', short.slice(0, 9).join(',') === '29,40,107,4,0,49,65,50,0')
ok('...then module size', short.slice(9, 12).join(',') === '29,40,107')
ok('...and it ends with the print command', short.slice(-8).join(',').endsWith('29,40,107,3,0,49,81,48'))

/*
 * THE ONE THAT MATTERS. 300 bytes of payload means a stored-data length of 303,
 * which does not fit in one byte: pL is 303 & 0xff = 47 and pH is 1. A build
 * that wrote the length the wrong way round, or forgot the +3, prints nothing
 * at all and only for long payloads.
 */
const long = bytesOf(longUrl)
const storeAt = long.findIndex(
  (b, i) => b === 0x1d && long[i + 1] === 0x28 && long[i + 2] === 0x6b && long[i + 5] === 49 && long[i + 6] === 80,
)
ok('the store command is present for a long payload', storeAt >= 0)
if (storeAt >= 0) {
  const pL = long[storeAt + 3]
  const pH = long[storeAt + 4]
  const declared = pL + pH * 256
  ok(
    'its length is payload + 3, little-endian',
    declared === longUrl.length + 3,
    `pL=${pL} pH=${pH} -> ${declared}, payload ${longUrl.length}`,
  )
  ok('...and pH is genuinely non-zero here', pH > 0, 'or the test proves nothing about the split')
}

ok('an empty payload emits nothing', bytesOf('').length === 0)

/* ── the A4 page ─────────────────────────────────────────────────────────── */

console.log('\n-- on a page --\n')

function qrSpec(target: string, url?: string, caption?: string): DocumentSpec {
  return {
    version: 1,
    blocks: [
      {
        id: 'qr-1',
        kind: 'qr',
        band: 'footer',
        x: 0,
        y: 0,
        w: 25,
        qrTarget: target as never,
        ...(url ? { qrUrl: url } : {}),
        ...(caption ? { qrCaption: caption } : {}),
      },
    ],
  }
}

const markup = compileDocument(qrSpec('store', undefined, 'Scan to visit us'), 'invoice')
ok('the compiled page carries a marker, not an image', markup.includes('{{qr:store:') && !markup.includes('<img'))
ok('the caption is escaped into the markup', markup.includes('Scan to visit us'))

const printed = renderTemplate(markup, 'invoice', { values: {}, sections: {}, capabilities: caps, qr: CTX })
ok('a configured store becomes a picture', printed.includes('<img src="data:image/png;base64,'))
ok('...the marker is gone', !printed.includes('{{qr'))
ok('...and the caption survives', printed.includes('Scan to visit us'))

const unconfigured = renderTemplate(markup, 'invoice', { values: {}, sections: {}, capabilities: caps, qr: EMPTY })
ok('no store configured means NO SQUARE', !unconfigured.includes('<img'))
ok('...but the caption still prints', unconfigured.includes('Scan to visit us'), 'so the layout does not jump')
ok('...and no marker is left behind', !unconfigured.includes('{{qr'))

const noCtx = renderTemplate(markup, 'invoice', { values: {}, sections: {}, capabilities: caps })
ok('a caller that supplies no context renders nothing', !noCtx.includes('<img'), 'absent fails closed')

/* A typed address rides as an attribute, so it must survive the round trip. */
const customMarkup = compileDocument(qrSpec('custom', 'https://rate.example/us'), 'invoice')
const customOut = renderTemplate(customMarkup, 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
  qr: EMPTY,
})
ok(
  'a typed address works even with nothing else configured',
  customOut.includes('<img src="data:image/png;base64,'),
  'it depends on no setting',
)

/* ── storage ─────────────────────────────────────────────────────────────── */

console.log('\n-- storage --\n')

const round = parseSpec(serialiseSpec(qrSpec('doc', undefined, 'Track this order')), 'invoice')
ok('the target survives a save', round?.blocks[0]?.qrTarget === 'doc')
ok('...and the caption', round?.blocks[0]?.qrCaption === 'Track this order')

const badUrl = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...qrSpec('custom').blocks[0], qrUrl: 'javascript:alert(1)' }] }),
  'invoice',
)
ok(
  'a dangerous stored address is dropped on read',
  badUrl?.blocks[0]?.qrUrl === undefined,
  'a design can be older than the rules',
)

const badTarget = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...qrSpec('custom').blocks[0], qrTarget: 'elsewhere' }] }),
  'invoice',
)
ok('an unknown target is dropped', badTarget?.blocks[0]?.qrTarget === undefined)

/* ── the slip: both renderers must agree ─────────────────────────────────── */

console.log('\n-- on a slip --\n')

function receipt(links?: ReceiptData['qrLinks']): ReceiptData {
  return {
    proForma: false,
    gift: false,
    siteName: 'Test Shop',
    vatNumber: '4123456789',
    documentNumber: 'INV0001',
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
    ...(links ? { qrLinks: links } : {}),
  }
}

const slipSpec: SlipSpec = {
  version: 1,
  blocks: [
    { kind: 'siteName' },
    { kind: 'title' },
    { kind: 'lines' },
    { kind: 'qr', qrTarget: 'review', qrCaption: 'Scan to rate us' },
  ],
}

const links = { appUrl: 'https://app.example', storeUrl: 'https://shop.example/', reviewUrl: 'https://g.page/r/x' }
const withQr = Buffer.from(renderSlipSpec(slipSpec, receipt(links)))
const withoutQr = Buffer.from(renderSlipSpec(slipSpec, receipt()))

ok('the roll carries GS ( k when there is a link', withQr.includes(Buffer.from([0x1d, 0x28, 0x6b])))
ok('...and the address itself', withQr.toString('latin1').includes('g.page/r/x'))
ok('...and the caption', withQr.toString('latin1').includes('Scan to rate us'))
ok('no link means no command at all', !withoutQr.includes(Buffer.from([0x1d, 0x28, 0x6b])))
ok('...and no caption either', !withoutQr.toString('latin1').includes('Scan to rate us'))

const htmlWith = slipBlockHtml(slipSpec, receipt(links)).join('')
const htmlWithout = slipBlockHtml(slipSpec, receipt()).join('')
ok('the HTML slip draws it as a picture', htmlWith.includes('data:image/png;base64,'))
ok('...and omits it for the same reason the bytes do', !htmlWithout.includes('data:image/png'))
ok(
  'BOTH slip renderers make the same call',
  withQr.includes(Buffer.from([0x1d, 0x28, 0x6b])) === htmlWith.includes('data:image/png;base64,') &&
    !withoutQr.includes(Buffer.from([0x1d, 0x28, 0x6b])) === !htmlWithout.includes('data:image/png'),
  'the guarantee the whole slip rests on',
)

const slipRound = parseSlip(serialiseSlip(slipSpec))
ok('a slip QR survives a save', slipRound?.blocks[3]?.qrTarget === 'review')

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} QR check(s) failed.`)
  process.exit(1)
}
console.log('All QR checks passed.')

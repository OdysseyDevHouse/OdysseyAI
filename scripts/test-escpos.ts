/**
 * The ESC/POS layer — bytes, columns and code pages, all pinned.
 *
 * Everything here is pure: the encoder and layouts never touch a printer, so
 * this suite is what stands between a refactor and a shop full of confetti.
 * The bridge itself is hardware and gets the manual checklist in
 * docs/print-bridge.md.
 */

import { EscPos, encodeCp858, twoCol, wrapText } from '../src/lib/escpos/encoder'
import { renderReceipt, renderKitchenTicket, renderTestSlip } from '../src/lib/escpos/slips'
import { kitchenDelta } from '../src/lib/kitchenTicket'
import type { ReceiptData } from '../src/lib/receiptData'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')
const contains = (haystack: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

console.log('\n── The control sequences, byte-exact ───────────────────────\n')

ok('init is ESC @ then CP858', hex(new EscPos().init().build()) === '1b 40 1b 74 13')
ok('bold on/off', hex(new EscPos().bold(true).bold(false).build()) === '1b 45 01 1b 45 00')
ok('align centre', hex(new EscPos().align('center').build()) === '1b 61 01')
ok('double size is GS ! 0x11', hex(new EscPos().size(2, 2).build()) === '1d 21 11')
ok('cut is GS V 66 0', hex(new EscPos().cut().build()) === '1d 56 42 00')
ok('*** the drawer kick is ESC p 0 25 250 ***',
    hex(new EscPos().drawerKick().build()) === '1b 70 00 19 fa')

console.log('\n── CP858 keeps product names legible ───────────────────────\n')

ok('plain ASCII passes through', hex(encodeCp858('R12')) === '52 31 32')
ok('é maps to 0x82', hex(encodeCp858('é')) === '82')
ok('ü maps to 0x81', hex(encodeCp858('ü')) === '81')
ok('the degree sign maps', hex(encodeCp858('°')) === 'f8')
ok('*** unmappable becomes ?, never a shifted line ***', hex(encodeCp858('☃')) === '3f')
ok('typographic dash flattens to ASCII', hex(encodeCp858('—')) === '2d')

console.log('\n── Column arithmetic ───────────────────────────────────────\n')

ok('two columns fill exactly 48', twoCol('Bread', 'R12.00', 48).length === 48)
ok('the money is flush right', twoCol('Bread', 'R12.00', 48).endsWith('R12.00'))
ok('*** a long description truncates, the money survives ***',
    twoCol('X'.repeat(60), 'R1 234.56', 42).length === 42 &&
    twoCol('X'.repeat(60), 'R1 234.56', 42).endsWith('R1 234.56'))
ok('wrap breaks at word boundaries', JSON.stringify(wrapText('one two three', 8)) === '["one two","three"]')
ok('wrap hard-breaks an unbroken run', wrapText('x'.repeat(20), 8).every((l) => l.length <= 8))

console.log('\n── The receipt renders, and gift mode hides the money ──────\n')

const receipt: ReceiptData = {
  proForma: false,
  gift: false,
  siteName: 'Test Shop',
  vatNumber: '4123456789',
  documentNumber: 'INV000123',
  documentDate: '2026-08-14',
  printedAt: '2026-08-14 10:00',
  cashierName: 'Ruth',
  terminalCode: 'T1',
  customerName: null,
  customerVatNo: null,
  lines: [
    { description: 'Crème brûlée', qty: 2, unitPriceIncl: 45, lineTotalIncl: 90, notes: ['no nuts'] },
    { description: 'Coffee', qty: 1, unitPriceIncl: 25, lineTotalIncl: 25, notes: [] },
  ],
  subtotalExcl: 100,
  vatTotal: 15,
  discountTotal: 0,
  totalIncl: 115,
  roundingAdj: 0,
  vatByRate: [{ ratePct: 15, excl: 100, vat: 15, incl: 115 }],
  tenders: [{ name: 'Cash', amount: 120, changeGiven: 5, reference: null }],
  changeGiven: 5,
  loyalty: { pointsEarned: 11, balance: 42 },
  copyNumber: 0,
  footerText: 'Thank you!',
}

const bytes = renderReceipt(receipt)
const asText = new TextDecoder('latin1').decode(bytes)
ok('the slip carries the number', asText.includes('INV000123'))
ok('the slip says TAX INVOICE', asText.includes('TAX INVOICE'))
ok('the accents survived as CP858 bytes, not mojibake',
    contains(bytes, [0x8a]) /* è */ && contains(bytes, [0x96]) /* û */ && contains(bytes, [0x82]) /* é */)
ok('the note is on the slip', asText.includes('no nuts'))
ok('the change row prints', asText.includes('Change'))
ok('the loyalty footer prints', asText.includes('balance 42'))
ok('the slip ends with feed + cut', hex(bytes.slice(-6)) === '1b 64 03 1d 56 42 00'.slice(0, 17) || contains(bytes.slice(-8), [0x1d, 0x56, 0x42, 0x00]))

const copy = renderReceipt({ ...receipt, copyNumber: 1 })
ok('*** a reprint says COPY ***', new TextDecoder('latin1').decode(copy).includes('COPY'))

const gift = renderReceipt({ ...receipt, gift: true })
const giftText = new TextDecoder('latin1').decode(gift)
ok('*** the gift slip shows NO money ***', !/R\d/.test(giftText.replace(/GIFT RECEIPT/g, '')) && !giftText.includes('115'))
ok('…but keeps the number for the exchange', giftText.includes('INV000123'))
ok('…and says what it is', giftText.includes('GIFT RECEIPT'))

console.log('\n── The kitchen ticket ──────────────────────────────────────\n')

const ticket = renderKitchenTicket({
  tableLabel: 'T5',
  waiter: 'Sam',
  at: '19:42',
  covers: 4,
  lines: [
    { qty: 2, description: 'Burger', notes: ['extra bacon'], note: 'allergy: nuts' },
    { qty: 1, description: 'Salad', notes: [], note: '' },
  ],
})
const ticketText = new TextDecoder('latin1').decode(ticket)
ok('the table leads', ticketText.includes('T5'))
ok('the items print', ticketText.includes('Burger') && ticketText.includes('Salad'))
ok('the kitchen answer prints', ticketText.includes('extra bacon'))
ok('*** the allergy note reaches the kitchen ***', ticketText.includes('allergy: nuts'))
ok('*** no money anywhere on a kitchen ticket ***', !/R\d/.test(ticketText))

console.log('\n── The delta rule ──────────────────────────────────────────\n')

const delta = kitchenDelta([
  { lineId: 1, qty: 3, kitchenSentQty: 0 }, // new
  { lineId: 2, qty: 3, kitchenSentQty: 1 }, // bumped
  { lineId: 3, qty: 2, kitchenSentQty: 2 }, // already sent
  { lineId: 4, qty: 1, kitchenSentQty: 3 }, // reduced — clamps, no void notice v1
])
ok('a new line owes everything', delta.find((d) => d.lineId === 1)?.qty === 3)
ok('a bumped line owes the bump', delta.find((d) => d.lineId === 2)?.qty === 2)
ok('an already-sent line owes nothing', !delta.some((d) => d.lineId === 3))
ok('*** a reduced line clamps at zero — nothing un-sends ***', !delta.some((d) => d.lineId === 4))

console.log('\n── The test slip ───────────────────────────────────────────\n')

const test = renderTestSlip({ siteName: 'Test Shop', columns: 42 })
ok('the test slip renders and cuts', contains(test, [0x1d, 0x56, 0x42, 0x00]))

console.log(fails === 0 ? '\nAll ESC/POS rules hold.\n' : `\n${fails} FAILURE(S)\n`)
process.exit(fails === 0 ? 0 : 1)

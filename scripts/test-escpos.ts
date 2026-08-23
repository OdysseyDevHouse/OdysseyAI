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
import { kitchenDelta, groupKitchenLines } from '../src/lib/kitchenTicket'
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
  /* The pudding is on a special and the coffee is not, so one render exercises
     both branches: a line that must show what it saved, and one that must stay
     silent rather than printing "0% off". */
  lines: [
    {
      description: 'Crème brûlée',
      qty: 2,
      unitPriceIncl: 45,
      lineTotalIncl: 81,
      discountPct: 10,
      discountIncl: 9,
      specialName: 'Pudding Hour',
      notes: ['no nuts'],
    },
    {
      description: 'Coffee',
      qty: 1,
      unitPriceIncl: 25,
      lineTotalIncl: 25,
      discountPct: 0,
      discountIncl: 0,
      specialName: null,
      notes: [],
    },
    /* A REWARD line — the promotion GAVE this, it did not reduce it. A special
       with no discount, which is the case that used to print a bare R0.00. */
    {
      description: 'Garlic Bread',
      qty: 1,
      unitPriceIncl: 0,
      lineTotalIncl: 0,
      discountPct: 0,
      discountIncl: 0,
      specialName: 'Pudding Hour',
      notes: [],
    },
  ],
  subtotalExcl: 92.17,
  vatTotal: 13.83,
  discountTotal: 9,
  totalIncl: 106,
  roundingAdj: 0,
  vatByRate: [{ ratePct: 15, excl: 92.17, vat: 13.83, incl: 106 }],
  tenders: [{ name: 'Cash', amount: 110, changeGiven: 4, reference: null }],
  changeGiven: 4,
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
ok('*** a discounted line names the special and shows the percentage ***',
    asText.includes('Pudding Hour') && asText.includes('10% off'))
ok('*** …and what it took off, in rands ***', /-R\s?9\.00/.test(asText))
/* One "off" row on the slip, not two. Substring-matching '0% off' would be
   satisfied by the pudding's own '10% off' and prove nothing. */
ok('an undiscounted line says nothing about a discount',
    (asText.match(/% off/g) ?? []).length === 1)
/* The giveaway. It has a special but NO discount, so it must name the promotion
   and say Free — never a bare R0.00, which reads as a pricing error — and it
   must not claim a percentage came off it. */
ok('*** a reward line says which promotion gave it, and that it is Free ***',
    /Pudding Hour +Free/.test(asText))
ok('…and never claims a percentage came off a giveaway',
    !/Pudding Hour +[\d.]+% off/.test(asText))
ok('the change row prints', asText.includes('Change'))
ok('the loyalty footer prints', asText.includes('balance 42'))
ok('the slip ends with feed + cut', hex(bytes.slice(-6)) === '1b 64 03 1d 56 42 00'.slice(0, 17) || contains(bytes.slice(-8), [0x1d, 0x56, 0x42, 0x00]))

const copy = renderReceipt({ ...receipt, copyNumber: 1 })
ok('*** a reprint says COPY ***', new TextDecoder('latin1').decode(copy).includes('COPY'))

const gift = renderReceipt({ ...receipt, gift: true })
const giftText = new TextDecoder('latin1').decode(gift)
ok('*** the gift slip shows NO money ***', !/R\d/.test(giftText.replace(/GIFT RECEIPT/g, '')) && !giftText.includes('106'))
ok('…but keeps the number for the exchange', giftText.includes('INV000123'))
ok('…and says what it is', giftText.includes('GIFT RECEIPT'))

console.log('\n── The kitchen ticket ──────────────────────────────────────\n')

const ticket = renderKitchenTicket({
  tableLabel: 'T5',
  printerName: 'Grill',
  waiter: 'Sam',
  at: '19:42',
  covers: 4,
  groups: [
    {
      title: 'Mains',
      lines: [{ qty: 2, description: 'Burger', notes: ['extra bacon'], note: 'allergy: nuts' }],
    },
    { title: '', lines: [{ qty: 1, description: 'Salad', notes: [], note: '' }] },
  ],
})
const ticketText = new TextDecoder('latin1').decode(ticket)
ok('the table leads', ticketText.includes('T5'))
ok('*** the ticket says which printer it is for ***', ticketText.includes('Grill'))
ok('the items print', ticketText.includes('Burger') && ticketText.includes('Salad'))
ok('the kitchen answer prints', ticketText.includes('extra bacon'))
ok('*** the allergy note reaches the kitchen ***', ticketText.includes('allergy: nuts'))
ok('the course heading prints', ticketText.includes('MAINS'))
ok('*** no money anywhere on a kitchen ticket ***', !/R\d/.test(ticketText))

// One course only — a heading over a ticket whose every line is a main is
// noise on an 80mm roll, so it is suppressed.
const oneCourse = new TextDecoder('latin1').decode(
  renderKitchenTicket({
    tableLabel: 'T6',
    printerName: 'Bar',
    waiter: 'Sam',
    at: '19:45',
    covers: 2,
    groups: [{ title: 'Drinks', lines: [{ qty: 1, description: 'Coke', notes: [], note: '' }] }],
  }),
)
ok('*** a single course prints no heading ***', !oneCourse.includes('DRINKS'))

console.log('\n── The cancellation ticket ─────────────────────────────────\n')

/* A chef reads these at arm's length across a hot pass. Everything here is
   about one failure mode: a cancellation mistaken for an order ADDS a plate
   instead of removing one, which is worse than never printing it. */
const cancel = new TextDecoder('latin1').decode(
  renderKitchenTicket({
    tableLabel: 'T5',
    printerName: 'Grill',
    waiter: 'Sam',
    at: '19:58',
    covers: 4,
    cancelled: true,
    reason: 'Customer left',
    groups: [
      { title: 'Mains', lines: [{ qty: 2, description: 'Burger', notes: [], note: '' }] },
    ],
  }),
)
ok('*** the banner leads, before the table ***',
   cancel.indexOf('CANCELLED') < cancel.indexOf('T5'))
ok('*** it says what to DO, not just what happened ***', cancel.includes('DO NOT MAKE'))
ok('*** every line carries the word, not just the header ***',
   /CANCEL 2 x Burger/.test(cancel))
ok('the reason reaches the chef', cancel.includes('Customer left'))
/* Twice: once at the top, once at the bottom. Measured on the last PRINTED
   line rather than the last bytes — feed and cut are control codes and always
   trail the text. */
/* The feed-and-cut tail is dropped before looking at the last line. Matching on
   "a line containing a letter" is not enough: ESC d 3 and GS V B 0 are control
   bytes that happen to include letters, so the naive version finds the cut
   sequence rather than the banner. Everything printable-and-not-control is what
   a chef can actually read. */
const cancelLines = cancel
  .split('\n')
  .map((l) => l.replace(/[\x00-\x1f]/g, ''))
  // A WORD, not just a letter. What survives stripping the cut sequence is
  // "dVB" — letters with no spaces, which no line a chef reads ever is.
  .filter((l) => /[A-Za-z]{2,}\s|\*{4,}/.test(l))
ok('*** it says CANCELLED at the end too — paper tears from the top ***',
   (cancel.match(/CANCELLED/g) ?? []).length === 2 &&
     (cancelLines[cancelLines.length - 1] ?? '').includes('CANCELLED'))
ok('no money on a cancellation either', !/R\d/.test(cancel))

// An ordinary ticket must gain none of it — the banner is the whole signal.
ok('*** an ordinary ticket is never marked cancelled ***',
   !ticketText.includes('CANCELLED') && !ticketText.includes('CANCEL '))

console.log('\n── The delta rule ──────────────────────────────────────────\n')

const delta = kitchenDelta([
  { lineId: 1, qty: 3, sentQty: 0 }, // new
  { lineId: 2, qty: 3, sentQty: 1 }, // bumped
  { lineId: 3, qty: 2, sentQty: 2 }, // already sent
  { lineId: 4, qty: 1, sentQty: 3 }, // reduced — clamps, no void notice v1
])
ok('a new line owes everything', delta.find((d) => d.lineId === 1)?.qty === 3)
ok('a bumped line owes the bump', delta.find((d) => d.lineId === 2)?.qty === 2)
ok('an already-sent line owes nothing', !delta.some((d) => d.lineId === 3))
ok('*** a reduced line clamps at zero — nothing un-sends ***', !delta.some((d) => d.lineId === 4))

// The case the user described: 3 Cokes already sent, 2 more added, only 2 print.
const bumped = kitchenDelta([{ lineId: 9, qty: 5, sentQty: 3 }])
ok('*** 3 sent + 2 added prints exactly 2 ***', bumped[0]?.qty === 2)

console.log('\n── Grouping ────────────────────────────────────────────────\n')

const grouped = groupKitchenLines([
  { qty: 1, description: 'Calamari', notes: [], note: '', kitchenGroup: 'Starters' },
  { qty: 1, description: 'Steak', notes: [], note: '', kitchenGroup: 'Mains' },
  { qty: 1, description: 'Prawns', notes: [], note: '', kitchenGroup: 'starters ' },
  { qty: 1, description: 'Bread', notes: [], note: '', kitchenGroup: '' },
])
ok('groups appear in the order first rung', grouped[0]?.title === 'Starters')
ok('*** case and spacing do not split a course ***', grouped[0]?.lines.length === 2)
ok('the first spelling wins the heading', grouped.every((g) => g.title !== 'starters '))
ok('*** ungrouped lines print last, under no heading ***', grouped.at(-1)?.title === '')

console.log('\n── The test slip ───────────────────────────────────────────\n')

const test = renderTestSlip({ siteName: 'Test Shop', columns: 42 })
ok('the test slip renders and cuts', contains(test, [0x1d, 0x56, 0x42, 0x00]))

console.log(fails === 0 ? '\nAll ESC/POS rules hold.\n' : `\n${fails} FAILURE(S)\n`)
process.exit(fails === 0 ? 0 : 1)

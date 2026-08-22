/**
 * The slip builders — pure, and the "one builder, two printers" promise.
 *
 * receiptDataFor reads a posted document; receiptDataFromBasket builds the
 * offline slip from what the till holds. For an equivalent sale the two must
 * agree — that is what makes the paper handed over offline match the
 * document that posts at sync.
 */

import { receiptDataFor, receiptDataFromBasket, receiptNotes } from '../src/lib/receiptData'
import type { SalesDocument } from '../src/lib/site/salesDocuments'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const instruction = (name: string, onReceipt: boolean, qty = 1) => ({
  id: 1, groupId: 1, groupName: 'Extras', optionId: 1, optionName: name,
  qty, priceAdjustIncl: 0, lineAdjustIncl: 0, productId: null, stockQtyPer: 0,
  printsOnKitchen: !onReceipt, printsOnReceipt: onReceipt,
})

const doc = {
  id: 9, docType: 'invoice', docLabel: 'Invoice', status: 'finalised',
  documentNumber: 'INV000042', documentDate: '2026-08-14', dueDate: null,
  customerId: null, customerCode: null, customerName: 'Walk-in', customerVatNo: null,
  customerPhone: null, customerAddress: null, priceStructureId: null,
  userId: 1, userName: 'Ruth', terminalId: 1, terminalCode: 'T1',
  origin: 'till', subtotalExcl: 100, vatTotal: 15, discountTotal: 10,
  totalIncl: 115, roundingAdj: -0.02, tenderedTotal: 120, changeGiven: 5,
  convertedFromId: null, reversesId: null, reference: null, notes: null,
  personCount: null, visitTypeId: null, internalNote: null, cancelReason: null,
  cancelReasonId: null, returnReasonId: null, cancelledAt: null, finalisedAt: null,
  printCount: 2, createdAt: new Date(0), updatedAt: new Date(0),
  lines: [
    {
      id: 1, documentId: 9, lineNumber: 1, productId: 1, productCode: 'B1',
      description: 'Burger', productType: 'normal', departmentId: null,
      salesRepId: null, salesRepName: null, salesRepUserId: null,
      qty: 2, qtyDelivered: 0, unitPriceIncl: 62.5, discountPct: 8, discountIncl: 10,
      vatRatePct: 15, lineTotalIncl: 115, lineTotalExcl: 100, lineVat: 15,
      unitCostExcl: 20, specialId: null,
      instructions: [instruction('extra bacon', true), instruction('well done', false)],
      kitchenSentQty: 0, note: '',
    },
  ],
} as unknown as SalesDocument

const site = { name: 'Test Shop', vatNumber: '4123456789' }
const tenders = [{ name: 'Cash', amount: 120, changeGiven: 5, reference: null }]

console.log('\n── The posted-document builder ─────────────────────────────\n')

const built = receiptDataFor(doc, site, tenders, {
  printedAt: 'now', copyNumber: 2, footerText: 'Bye', loyalty: { pointsEarned: 3, balance: 30 },
})
ok('header facts ride through', built.documentNumber === 'INV000042' && built.cashierName === 'Ruth')
ok('*** only prints_on_receipt answers appear ***',
    JSON.stringify(built.lines[0].notes) === '["extra bacon"]', JSON.stringify(built.lines[0].notes))
ok('the stored money is canonical', built.totalIncl === 115 && built.roundingAdj === -0.02)
ok('the VAT split recomputes', built.vatByRate.length === 1 && built.vatByRate[0].ratePct === 15)
ok('copyNumber passes through', built.copyNumber === 2)
ok('loyalty passes through', built.loyalty?.balance === 30)

let threw = false
try {
  receiptDataFor({ ...doc, documentNumber: null } as SalesDocument, site, tenders, { printedAt: 'x' })
} catch {
  threw = true
}
ok('*** an unnumbered sale refuses — it is not a tax invoice ***', threw)

console.log('\n── One builder, two printers ───────────────────────────────\n')

const offline = receiptDataFromBasket({
  siteName: site.name,
  vatNumber: site.vatNumber,
  documentNumber: 'INV000042',
  documentDate: '2026-08-14',
  printedAt: 'now',
  cashierName: 'Ruth',
  terminalCode: 'T1',
  customerName: 'Walk-in',
  lines: [
    {
      description: 'Burger', qty: 2, unitPriceIncl: 62.5, discountIncl: 10, vatRatePct: 15,
      instructions: [
        { optionName: 'extra bacon', qty: 1, printsOnReceipt: true },
        { optionName: 'well done', qty: 1, printsOnReceipt: false },
      ],
    },
  ],
  tenders,
  changeGiven: 5,
})
ok('*** the offline slip agrees with the posted one, line for line ***',
    JSON.stringify(offline.lines) === JSON.stringify(built.lines),
    JSON.stringify(offline.lines))
ok('…and total for total', offline.totalIncl === built.totalIncl,
    `${offline.totalIncl} vs ${built.totalIncl}`)

/*
 * The SAME agreement, with the shape the real caller actually sends.
 *
 * The fixture above OMITS discountPct, so a nullish fallback satisfies it. But
 * PosShell's snapshot passes `salePayloadLines` output, and that always emits
 * discountPct — as 0 on exactly the line this is about, one reduced only by a
 * document discount's apportioned share. A `??` reads that stated 0 as a claim
 * and echoes it back, so the slip prints "0% off" beside a real R10 discount
 * and the bug survives on the one path it was written for.
 *
 * Pinned separately rather than by changing the fixture above: both shapes are
 * legitimate callers and both must derive the same percentage.
 */
const offlineStatedZero = receiptDataFromBasket({
  siteName: site.name,
  vatNumber: site.vatNumber,
  documentNumber: 'INV000042',
  documentDate: '2026-08-14',
  printedAt: 'now',
  cashierName: 'Ruth',
  terminalCode: 'T1',
  customerName: 'Walk-in',
  lines: [
    {
      description: 'Burger', qty: 2, unitPriceIncl: 62.5,
      // Stated, and zero — what salePayloadLines emits for a doc-discount line.
      discountPct: 0, discountIncl: 10, vatRatePct: 15,
      instructions: [
        { optionName: 'extra bacon', qty: 1, printsOnReceipt: true },
        { optionName: 'well done', qty: 1, printsOnReceipt: false },
      ],
    },
  ],
  tenders,
  changeGiven: 5,
})
ok('*** a STATED zero percent is derived too, not echoed ***',
    offlineStatedZero.lines[0].discountPct === built.lines[0].discountPct,
    `offline ${offlineStatedZero.lines[0].discountPct}% vs posted ${built.lines[0].discountPct}%`)
ok('…so the counter slip and the reprint make the same claim',
    JSON.stringify(offlineStatedZero.lines) === JSON.stringify(built.lines))

/* And a caller that states a REAL percentage still wins — the derivation is a
   fallback for "nothing was claimed", not an override of what was. */
const offlineStatedPct = receiptDataFromBasket({
  siteName: site.name, vatNumber: site.vatNumber, documentNumber: 'INV000042',
  documentDate: '2026-08-14', printedAt: 'now', cashierName: 'Ruth',
  terminalCode: 'T1', customerName: 'Walk-in',
  lines: [{ description: 'Burger', qty: 2, unitPriceIncl: 62.5,
            discountPct: 8, vatRatePct: 15 }],
  tenders, changeGiven: 5,
})
ok('a stated percentage is not overridden', offlineStatedPct.lines[0].discountPct === 8,
    `${offlineStatedPct.lines[0].discountPct}%`)
ok('…and VAT for VAT', JSON.stringify(offline.vatByRate) === JSON.stringify(built.vatByRate))
ok('offline carries no loyalty and copy 0', offline.loyalty === null && offline.copyNumber === 0)

/*
 * ── WHO IS ON THE SLIP ─────────────────────────────────────────────────────
 *
 * The two builders reach the cashier's name by different routes: the posted one
 * from the DOCUMENT's `user_name`, the offline one from what the till hands it.
 * They must land on the same person, because the paper given to the customer
 * offline is the paper that must match the invoice posted at sync.
 *
 * This is not hypothetical. Until `withTillOperator` landed, the posted slip
 * printed the BROWSER session's user while the offline slip printed the PIN
 * operator — so on a shared machine the same sale printed two different
 * cashiers depending on whether the line was up. The two builders were never
 * compared on this field, so the divergence lived here unnoticed.
 */
ok('*** both slips name the same cashier ***',
    offline.cashierName === built.cashierName,
    `offline "${offline.cashierName}" vs posted "${built.cashierName}"`)

/* And that the posted one takes it from the document rather than inventing it:
   `user_name` is a snapshot written at save time from the actor, so a slip that
   read anything else would be naming somebody the sale does not record. */
ok('the posted slip takes its cashier from the document',
    built.cashierName === doc.userName,
    `${built.cashierName} vs ${doc.userName}`)

console.log('\n── A free item a promotion handed over ─────────────────────\n')

/*
 * ── WHY THIS NEEDS ITS OWN CASE ──────────────────────────────────────────
 *
 * A reward line is what a "buy two pizzas, get a garlic bread" promotion puts
 * on the sale: an ordinary line at ZERO price, carrying the special that
 * granted it. It is the one line on the slip where the promotion did not take
 * money off — it handed something over — so `discountIncl` is legitimately 0.
 *
 * Every renderer guards its "why" row on `discountIncl > 0`, which is right for
 * a discount and wrong here: the free item prints as
 *
 *     1 x Garlic Bread                           R0.00
 *
 * with nothing saying why, so it reads as a pricing error rather than a
 * freebie. The builder's job is to carry the promotion's NAME through on such a
 * line; what each renderer then draws is its own business, but it cannot draw
 * what it was not given.
 */
const rewardDoc = {
  ...doc,
  lines: [
    doc.lines[0],
    {
      id: 2, documentId: 9, lineNumber: 2, productId: 7, productCode: 'GB',
      description: 'Garlic Bread', productType: 'normal', departmentId: null,
      salesRepId: null, salesRepName: null, salesRepUserId: null,
      qty: 1, qtyDelivered: 0, unitPriceIncl: 0, discountPct: 0, discountIncl: 0,
      vatRatePct: 15, lineTotalIncl: 0, lineTotalExcl: 0, lineVat: 0,
      unitCostExcl: 8, specialId: 42,
      instructions: [], kitchenSentQty: 0, note: '',
    },
  ],
} as unknown as SalesDocument

const withReward = receiptDataFor(rewardDoc, site, tenders, {
  printedAt: 'now',
  specialNames: new Map([[42, 'Pizza Tuesday']]),
})
const free = withReward.lines[1]

ok('the free line is on the slip', free?.description === 'Garlic Bread')
ok('at nothing', free?.lineTotalIncl === 0)
ok(
  '*** and it NAMES the promotion that gave it ***',
  free?.specialName === 'Pizza Tuesday',
  free?.specialName ?? '(null)',
  )
ok(
  'while carrying no discount, because none was taken off',
  free?.discountIncl === 0 && free?.discountPct === 0,
  'a renderer keying its "why" row on discountIncl > 0 will say nothing here',
)

console.log('\n── Notes formatting ────────────────────────────────────────\n')

ok('qty > 1 formats as a count',
    JSON.stringify(receiptNotes([{ optionName: 'shot', qty: 2, printsOnReceipt: true }])) ===
      '["2 × shot"]')
ok('the free-text note rides last',
    JSON.stringify(receiptNotes([], 'no ice')) === '["no ice"]')
ok('a blank note adds nothing', receiptNotes([], '  ').length === 0)

console.log(fails === 0 ? '\nAll slip-builder rules hold.\n' : `\n${fails} FAILURE(S)\n`)
process.exit(fails === 0 ? 0 : 1)

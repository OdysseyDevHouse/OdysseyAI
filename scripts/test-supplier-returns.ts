/**
 * Supplier returns — sending goods back after the receipt day.
 *
 * The mirror of a credit note, and the rules that matter are the same:
 *
 *   · the return is its OWN document, linked to the GRV, never an edit of it
 *   · it returns at the GRV's LANDED cost, not today's average
 *   · you cannot send back more than arrived, across ALL returns on that GRV
 *   · a serial line returns SPECIFIC units, and the two figures — stock and
 *     in-stock serials — must still agree afterwards
 *
 * A supplier return also must NOT unwind average_cost, for the same reason a
 * void does not: anything sold since has already moved on at the blended
 * figure. That is asserted here so nobody "fixes" it later.
 *
 *   npm run test:supplier-returns
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { createSupplier } from '../src/lib/site/suppliers'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplierReturn, returnableLines, returnsFor } from '../src/lib/site/purchaseReversal'
import { listSerials, reconcileSerials } from '../src/lib/site/serials'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances, listSupplierLedger } from '../src/lib/site/supplierLedger'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Return Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const PRODUCT_PATTERN = '^(RSER|RNRM)[0-9]{8}$'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${PRODUCT_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM serial_movements WHERE serial_id IN (SELECT id FROM product_serials WHERE product_id IN ${products})`)
  await siteExecute(SITE, `DELETE FROM product_serials WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${PRODUCT_PATTERN}'`)
  // The supplier and its documents are left behind on purpose: they are real
  // posted documents in a numbered sequence, and deleting the account they
  // belong to would punch a hole in the trail to tidy up a test.
}

const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

const avgOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT average_cost FROM products WHERE id=?', [id]))?.average_cost)

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  const vat =
    (await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1")) ??
    (await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1"))
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `RSUP${stamp}`,
    name: `Return Test Traders ${stamp}`,
    paymentTermsDays: 30,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  await siteExecute(SITE, `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost) VALUES (?,?, 'normal', 0, 0)`, [`RNRM${stamp}`, `Return Widget ${stamp}`])
  const widget = Number((await siteQueryOne<any>(SITE, 'SELECT id FROM products WHERE code=?', [`RNRM${stamp}`]))!.id)

  await siteExecute(SITE, `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost) VALUES (?,?, 'serial', 0, 0)`, [`RSER${stamp}`, `Return Handset ${stamp}`])
  const phone = Number((await siteQueryOne<any>(SITE, 'SELECT id FROM products WHERE code=?', [`RSER${stamp}`]))!.id)

  // ── Receive something to return ────────────────────────────────────────
  const grv = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    supplierInvoiceNo: `SINV-${stamp}`,
    lines: [
      { productId: widget, productCode: `RNRM${stamp}`, description: `Return Widget ${stamp}`, productType: 'normal', qtyReceived: 10, unitCostExcl: 50, vatRatePct: rate },
      { productId: phone, productCode: `RSER${stamp}`, description: `Return Handset ${stamp}`, productType: 'serial', qtyReceived: 3, unitCostExcl: 1000, vatRatePct: rate, serials: [`RS-${stamp}-A`, `RS-${stamp}-B`, `RS-${stamp}-C`] },
    ],
  })
  ok('a GRV posts to return against', grv.ok, grv.ok ? grv.documentNumber : grv.error)
  if (!grv.ok) { await sweepStrays(); process.exit(1) }

  const avgAfterReceipt = await avgOf(widget)
  const grvLines = (await returnableLines(SITE, grv.documentId))!
  const widgetLine = grvLines.find((l) => l.productId === widget)!
  const phoneLine = grvLines.find((l) => l.productId === phone)!

  ok('every line is fully returnable to start', widgetLine.returnable === 10 && phoneLine.returnable === 3,
    `${widgetLine.returnable}/${phoneLine.returnable}`)

  console.log('\n── Refusals ───────────────────────────────────────────────────\n')

  const noReason = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: '',
    lines: [{ sourceLineId: widgetLine.id, productId: widget, description: widgetLine.description, productType: 'normal', qtyReturned: 1, unitCostExcl: 50, vatRatePct: rate }],
  })
  ok('a return with no reason is refused', !noReason.ok, noReason.ok ? '' : noReason.error)

  const tooMany = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: 'Too many',
    lines: [{ sourceLineId: widgetLine.id, productId: widget, description: widgetLine.description, productType: 'normal', qtyReturned: 11, unitCostExcl: 50, vatRatePct: rate }],
  })
  ok('*** returning more than arrived is refused ***', !tooMany.ok, tooMany.ok ? '' : tooMany.error)

  const noSerials = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: 'No units chosen',
    lines: [{ sourceLineId: phoneLine.id, productId: phone, description: phoneLine.description, productType: 'serial', qtyReturned: 2, unitCostExcl: 1000, vatRatePct: rate, serialIds: [] }],
  })
  ok('*** a serial line with no units chosen is refused ***', !noSerials.ok, noSerials.ok ? '' : noSerials.error)

  ok('*** nothing moved on any refusal ***', (await stockOf(widget)) === 10 && (await stockOf(phone)) === 3,
    `${await stockOf(widget)}/${await stockOf(phone)}`)

  console.log('\n── A partial return ───────────────────────────────────────────\n')

  const serials = await listSerials(SITE, { productId: phone })
  const goingBack = serials.items.filter((s) => s.serial !== `RS-${stamp}-C`).map((s) => s.id)

  const first = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId,
    reason: 'Two handsets had cracked screens',
    supplierCreditNo: `THEIRCN-${stamp}`,
    lines: [
      { sourceLineId: widgetLine.id, productId: widget, description: widgetLine.description, productType: 'normal', qtyReturned: 4, unitCostExcl: 50, vatRatePct: rate },
      { sourceLineId: phoneLine.id, productId: phone, description: phoneLine.description, productType: 'serial', qtyReturned: 2, unitCostExcl: 1000, vatRatePct: rate, serialIds: goingBack },
    ],
  })
  ok('*** the return posts ***', first.ok, first.ok ? first.documentNumber : first.error)
  if (!first.ok) { await sweepStrays(); process.exit(1) }

  ok('it got its own SRT number', /^SRT/.test(first.documentNumber), first.documentNumber)
  ok('*** stock went OUT — widget 10 → 6 ***', (await stockOf(widget)) === 6, String(await stockOf(widget)))
  ok('*** and the phone 3 → 1 ***', (await stockOf(phone)) === 1, String(await stockOf(phone)))

  const doc = await siteQueryOne<any>(SITE, 'SELECT doc_type, status, reverses_id, total_incl, supplier_invoice_no FROM purchase_documents WHERE id=?', [first.documentId])
  ok('*** it is its own document, not an edit of the GRV ***', Number(doc.reverses_id) === grv.documentId, `reverses ${doc.reverses_id}`)
  ok('typed supplier_return and finalised', doc.doc_type === 'supplier_return' && doc.status === 'finalised')
  ok('*** stored NEGATIVE, so aggregates stay a plain SUM ***', toNum(doc.total_incl) < 0, String(toNum(doc.total_incl)))
  ok("their credit note number is kept", String(doc.supplier_invoice_no) === `THEIRCN-${stamp}`)

  // The units, specifically.
  const after = await listSerials(SITE, { productId: phone })
  const sent = after.items.filter((s) => s.status === 'returned_to_supplier')
  ok('*** exactly the two chosen units went back ***', sent.length === 2, String(sent.length))
  ok('and NOT the one that stayed', after.items.find((s) => s.serial === `RS-${stamp}-C`)?.status === 'in_stock')
  ok('*** a returned unit is distinguishable from a faulty customer return ***',
    sent.every((s) => s.status === 'returned_to_supplier'))
  ok('the rows survive — the trail is not erased', after.total === 3, String(after.total))
  ok('and each got a movement naming the return',
    (await siteQuery<any>(SITE, `SELECT COUNT(*) n FROM serial_movements WHERE action='returned_to_supplier' AND document_id=?`, [first.documentId]))[0].n === 2)

  console.log('\n── The invariants ─────────────────────────────────────────────\n')

  const sDrift = (await reconcileSerials(SITE)).filter((d) => d.productId === phone)
  ok('*** in-stock serials still equal stock on hand ***', sDrift.length === 0, JSON.stringify(sDrift))
  const mDrift = (await reconcileStock(SITE)).filter((d: any) => d.productId === phone || d.productId === widget)
  ok('*** Σ movements still equals stock_on_hand ***', mDrift.length === 0, JSON.stringify(mDrift))

  ok('*** average cost is NOT unwound ***', (await avgOf(widget)) === avgAfterReceipt,
    `${await avgOf(widget)} vs ${avgAfterReceipt}`)

  const ledger = await listSupplierLedger(SITE, sup.id)
  const credit = ledger.find((t) => t.reference === first.documentNumber)
  ok('the return reached the supplier ledger', !!credit, credit ? credit.docType : 'not found')
  // Direction is the point: on a CREDITOR account a negative signed amount is
  // less owed. A positive one would mean sending goods back had increased the
  // debt, which is the bug this assertion exists to catch.
  ok('*** and it REDUCES what we owe ***', (credit?.amountSigned ?? 0) < 0, String(credit?.amountSigned))
  ok('by the full value of the return', Math.abs(credit?.amountGross ?? 0) === 2530, String(credit?.amountGross))
  const balDrift = (await reconcileSupplierBalances(SITE)).filter((d: any) => (d.supplierId ?? d.id) === sup.id)
  ok('and the creditor balance still reconciles', balDrift.length === 0, JSON.stringify(balDrift))

  console.log('\n── A second return against the same GRV ───────────────────────\n')

  const left = (await returnableLines(SITE, grv.documentId))!
  const widgetLeft = left.find((l) => l.productId === widget)!
  ok('*** the remaining quantity accounts for the first return ***', widgetLeft.returnable === 6,
    `${widgetLeft.returnable} left, ${widgetLeft.alreadyReturned} returned`)

  const overNow = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: 'More than is left',
    lines: [{ sourceLineId: widgetLine.id, productId: widget, description: widgetLine.description, productType: 'normal', qtyReturned: 7, unitCostExcl: 50, vatRatePct: rate }],
  })
  ok('*** returning more than REMAINS is refused ***', !overNow.ok, overNow.ok ? '' : overNow.error)

  const second = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: 'The rest were the wrong colour',
    lines: [{ sourceLineId: widgetLine.id, productId: widget, description: widgetLine.description, productType: 'normal', qtyReturned: 6, unitCostExcl: 50, vatRatePct: rate }],
  })
  ok('a second return posts', second.ok, second.ok ? second.documentNumber : second.error)
  ok('*** stock is now zero ***', (await stockOf(widget)) === 0, String(await stockOf(widget)))

  const spent = (await returnableLines(SITE, grv.documentId))!.find((l) => l.productId === widget)!
  ok('*** and nothing is left to return ***', spent.returnable === 0, String(spent.returnable))

  const both = await returnsFor(SITE, grv.documentId)
  ok('the GRV knows about both returns', both.length === 2, String(both.length))

  // Trying to send back a unit that has already gone.
  const twice = await createSupplierReturn(SITE, actor, {
    grvId: grv.documentId, reason: 'Already gone',
    lines: [{ sourceLineId: phoneLine.id, productId: phone, description: phoneLine.description, productType: 'serial', qtyReturned: 1, unitCostExcl: 1000, vatRatePct: rate, serialIds: [goingBack[0]] }],
  })
  ok('*** a unit already returned cannot go back twice ***', !twice.ok, twice.ok ? '' : twice.error)

  const finalDrift = (await reconcileSerials(SITE)).filter((d) => d.productId === phone)
  ok('*** everything still reconciles at the end ***', finalDrift.length === 0, JSON.stringify(finalDrift))

  await sweepStrays()

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweepStrays()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})

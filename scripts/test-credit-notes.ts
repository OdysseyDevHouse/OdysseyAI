/**
 * Credit notes and the period lock.
 *
 * The rules that matter: a credit cannot exceed what was sold, cost comes from
 * the original line, stock comes back, the ledger reverses, and a locked VAT
 * period refuses everything.
 *
 *   npm run test:credit-notes
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { createCustomer, getCustomer } from '../src/lib/site/customers'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { createCreditNote, creditableLines, creditNotesFor } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { listLedger, reconcileBalances } from '../src/lib/site/customerLedger'
import { reconcileStock, listMovements } from '../src/lib/site/stockMovements'
import { setSetting } from '../src/lib/site/settings'
import { toNum } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0
let RETURN_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
  const r = await findSalesReasonByCode(SITE, 'return', 'FAULTY')
  if (!r) throw new Error('Seeded return reason FAULTY is missing — run site-migrate for 102.')
  RETURN_REASON_ID = r.id
}

const actor = { userId: 1, userName: 'Credit Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

async function main() {
  await loadReasonIds()
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',100,10,10,?,1)`,
    [`CRD${stamp}`, `Credit test ${stamp}`, vat?.id ?? null])
  const productId = p.insertId
  // Opening movement, so reconcileStock stays clean for this product.
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',100,100,10,'opening',1,'Credit Test')",
    [productId])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [productId])

  const cash = await getTenderByCode(SITE, 'CASH')
  const account = await getTenderByCode(SITE, 'ACCOUNT')
  const eft = await getTenderByCode(SITE, 'EFT')
  const cust = await createCustomer(SITE, actor, { code: `CRC${stamp}`, name: 'Credit Test Co', creditLimit: 5000, paymentTermsDays: 30 })
  if (!cust.ok || !cash || !account || !eft) { console.log('setup failed'); process.exit(1) }

  // ── An account invoice: 10 units at 115 (cost 10 each).
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerId: cust.id, customerName: 'Credit Test Co',
    lines: [{ productId, productCode: `CRD${stamp}`, description: 'Credit test item', productType: 'normal', qty: 10, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  if (!draft.ok) { console.log('draft failed'); process.exit(1) }
  const sale = await finaliseDocument(SITE, actor, { documentId: draft.id, customerId: cust.id, tenders: [{ tenderTypeId: account.id, amount: 1150 }] })
  ok('invoice posted', sale.ok, sale.ok ? sale.documentNumber : sale.error)
  if (!sale.ok) process.exit(1)

  const stockAfterSale = await stockOf(productId)
  ok('  stock down to 90', stockAfterSale === 90, String(stockAfterSale))
  ok('  customer owes 1150', (await getCustomer(SITE, cust.id))?.balance === 1150)

  // ── What can be credited
  const creditable = await creditableLines(SITE, draft.id)
  ok('creditable shows the full 10', creditable?.[0].creditable === 10, String(creditable?.[0].creditable))

  // Price changes AFTER the sale — the credit must NOT use the new cost.
  await siteExecute(SITE, 'UPDATE products SET average_cost = 25, last_cost = 25 WHERE id = ?', [productId])

  // ── Partial credit: 3 of 10 back.
  const line = creditable![0]
  const partial = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerId: cust.id, reasonId: RETURN_REASON_ID, note: 'Three returned damaged',
    lines: [{ sourceLineId: line.id, productId, productCode: line.productCode, description: line.description, productType: 'normal', qty: 3, unitPriceIncl: line.unitPriceIncl, vatRatePct: line.vatRatePct, unitCostExcl: line.unitCostExcl }],
  })
  ok('*** partial credit note posted ***', partial.ok, partial.ok ? partial.documentNumber : partial.error)
  if (!partial.ok) process.exit(1)
  ok('  numbered from the CRN sequence', partial.documentNumber.startsWith('CRN'), partial.documentNumber)
  ok('  worth 345 (3 × 115)', partial.total === 345, String(partial.total))

  const credited = await getDocument(SITE, partial.documentId)
  ok('  lines are NEGATIVE', credited!.lines[0].qty === -3, String(credited!.lines[0].qty))
  ok('  total is negative', credited!.totalIncl === -345, String(credited!.totalIncl))
  ok('  document balances', Math.round((credited!.subtotalExcl + credited!.vatTotal) * 100) === Math.round(credited!.totalIncl * 100))
  ok('*** cost copied from the ORIGINAL line, not today\'s 25 ***', credited!.lines[0].unitCostExcl === 10, String(credited!.lines[0].unitCostExcl))

  ok('  stock returned to 93', (await stockOf(productId)) === 93, String(await stockOf(productId)))
  const moves = await listMovements(SITE, productId, 3)
  ok('  a sale_return movement was written', moves[0]?.movementType === 'sale_return' && moves[0]?.qtyChange === 3)

  const balance = (await getCustomer(SITE, cust.id))?.balance
  ok('*** ledger reduced to 805 (1150 - 345) ***', balance === 805, String(balance))
  const ledger = await listLedger(SITE, cust.id)
  const cn = ledger.find((l) => l.docType === 'credit_note')
  ok('  credit note on the ledger', !!cn && cn.amountSigned === -345, String(cn?.amountSigned))
  ok('  auto-allocated against the invoice', cn?.amountOutstanding === 0, String(cn?.amountOutstanding))

  // ── Cannot credit more than remains
  const remaining = await creditableLines(SITE, draft.id)
  ok('creditable now shows 7 left', remaining?.[0].creditable === 7, String(remaining?.[0].creditable))
  const tooMuch = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerId: cust.id, reasonId: RETURN_REASON_ID, note: 'Too many',
    lines: [{ sourceLineId: line.id, productId, description: line.description, productType: 'normal', qty: 8, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  ok('*** over-crediting REFUSED ***', !tooMuch.ok, !tooMuch.ok ? tooMuch.error : '')

  // Exactly the remainder is fine.
  const rest = await createCreditNote(SITE, actor, {
    invoiceId: draft.id, customerId: cust.id, reasonId: RETURN_REASON_ID, note: 'Rest returned',
    lines: [{ sourceLineId: line.id, productId, description: line.description, productType: 'normal', qty: 7, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  ok('crediting exactly the remainder allowed', rest.ok, rest.ok ? '' : rest.error)
  ok('  balance back to 0', (await getCustomer(SITE, cust.id))?.balance === 0, String((await getCustomer(SITE, cust.id))?.balance))
  ok('  stock back to 100', (await stockOf(productId)) === 100, String(await stockOf(productId)))
  ok('  invoice now fully credited', (await creditableLines(SITE, draft.id))?.[0].creditable === 0)
  ok('  two credit notes linked to the invoice', (await creditNotesFor(SITE, draft.id)).length === 2)

  // ── Validation
  ok('credit without a reason refused', !(await createCreditNote(SITE, actor, { invoiceId: draft.id, reasonId: 0, lines: [] })).ok)
  // An id from the VOID list satisfies no foreign key on the returns column, and
  // must be refused before it can label a return with the wrong vocabulary.
  ok('credit with a void reason refused', !(await createCreditNote(SITE, actor, { invoiceId: draft.id, reasonId: 999999, lines: [] })).ok)
  ok('credit with no lines refused', !(await createCreditNote(SITE, actor, { invoiceId: draft.id, reasonId: RETURN_REASON_ID, lines: [] })).ok)

  // ── A no-receipt return: no invoice, cost falls back to what the caller gives.
  const cashDraft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: 'Walk-in',
    lines: [{ productId, productCode: `CRD${stamp}`, description: 'Credit test item', productType: 'normal', qty: 2, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  if (cashDraft.ok) await finaliseDocument(SITE, actor, { documentId: cashDraft.id, tenders: [{ tenderTypeId: cash.id, amount: 250 }] })

  const noReceipt = await createCreditNote(SITE, actor, {
    invoiceId: null, customerName: 'Walk-in', reasonId: RETURN_REASON_ID, note: 'Returned without a slip',
    lines: [{ productId, description: 'Credit test item', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
    refunds: [{ tenderTypeId: cash.id, amount: 115 }],
  })
  ok('*** no-receipt return accepted ***', noReceipt.ok, noReceipt.ok ? noReceipt.documentNumber : noReceipt.error)

  // EFT cannot be refunded at the till.
  const badRefund = await createCreditNote(SITE, actor, {
    invoiceId: null, customerName: 'Walk-in', reasonId: RETURN_REASON_ID, note: 'Refund by EFT',
    lines: [{ productId, description: 'Credit test item', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
    refunds: [{ tenderTypeId: eft.id, amount: 115 }],
  })
  ok('non-refundable tender refused', !badRefund.ok, !badRefund.ok ? badRefund.error : '')

  // ── The VAT period lock
  const today = new Date().toISOString().slice(0, 10)
  await setSetting(SITE, 'vat_period_locked_to', today)
  const locked = await createCreditNote(SITE, actor, {
    invoiceId: null, customerName: 'Walk-in', reasonId: RETURN_REASON_ID, note: 'After lock',
    lines: [{ productId, description: 'Credit test item', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })
  ok('*** locked VAT period REFUSES a credit ***', !locked.ok, !locked.ok ? locked.error : '')

  if (cashDraft.ok) {
    const lockedVoid = await voidDocument(SITE, actor, cashDraft.id, { reasonId: VOID_REASON_ID, note: 'After lock' })
    ok('*** locked VAT period REFUSES a void ***', !lockedVoid.ok, !lockedVoid.ok ? lockedVoid.error : '')
  }
  await setSetting(SITE, 'vat_period_locked_to', '')
  ok('unlocking lets it through again', (await createCreditNote(SITE, actor, {
    invoiceId: null, customerName: 'Walk-in', reasonId: RETURN_REASON_ID, note: 'After unlock',
    lines: [{ productId, description: 'Credit test item', productType: 'normal', qty: 1, unitPriceIncl: 115, vatRatePct: rate, unitCostExcl: 10 }],
  })).ok)

  // ── Invariants
  ok('*** reconcileStock zero drift ***', (await reconcileStock(SITE)).length === 0, JSON.stringify(await reconcileStock(SITE)))
  ok('*** reconcileBalances zero drift ***', (await reconcileBalances(SITE)).length === 0)

  // ── Cleanup: documents before the customer (FK is RESTRICT).
  const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE customer_id = ? OR customer_name = ?', [cust.id, 'Walk-in'])
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [d.id])
    await siteExecute(SITE, 'UPDATE sales_documents SET reverses_id = NULL WHERE reverses_id = ?', [d.id])
  }
  for (const d of docs) await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  await siteExecute(SITE, 'DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)', [cust.id, cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

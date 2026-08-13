/**
 * Purchasing — receiving goods, and the cost move.
 *
 * The rule that matters: a GRV is the ONLY thing that writes average_cost, and
 * it blends the LANDED cost (invoice + freight) into what was already on hand.
 * A costing bug here is silent and compounds with every receipt.
 *
 *   npm run test:purchasing
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { weightedAverageCost } from '../src/lib/documentMath'
import { createSupplier, getSupplier } from '../src/lib/site/suppliers'
import { receiveGoods, voidReceipt } from '../src/lib/site/purchasePosting'
import { reconcileStock, listMovements } from '../src/lib/site/stockMovements'
import { reconcileSupplierBalances, listSupplierLedger } from '../src/lib/site/supplierLedger'
import { setSetting } from '../src/lib/site/settings'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Purchase Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const product = async (id: number) =>
  (await siteQueryOne<any>(SITE, 'SELECT stock_on_hand, average_cost, last_cost FROM products WHERE id=?', [id]))!

async function main() {
  // ── The pure cost maths first: no database, every edge case.
  ok('blends two lots correctly',
    weightedAverageCost({ existingQty: 10, existingCostExcl: 10, receivedQty: 10, receivedCostExcl: 20 }) === 15,
    String(weightedAverageCost({ existingQty: 10, existingCostExcl: 10, receivedQty: 10, receivedCostExcl: 20 })))
  ok('weights by quantity, not evenly',
    weightedAverageCost({ existingQty: 90, existingCostExcl: 10, receivedQty: 10, receivedCostExcl: 20 }) === 11,
    String(weightedAverageCost({ existingQty: 90, existingCostExcl: 10, receivedQty: 10, receivedCostExcl: 20 })))
  ok('receiving nothing leaves the average alone',
    weightedAverageCost({ existingQty: 10, existingCostExcl: 7, receivedQty: 0, receivedCostExcl: 99 }) === 7)
  ok('*** zero stock takes the new cost outright ***',
    weightedAverageCost({ existingQty: 0, existingCostExcl: 999, receivedQty: 5, receivedCostExcl: 12 }) === 12)
  ok('*** NEGATIVE stock takes the new cost, not a nonsense blend ***',
    weightedAverageCost({ existingQty: -5, existingCostExcl: 10, receivedQty: 5, receivedCostExcl: 20 }) === 20,
    String(weightedAverageCost({ existingQty: -5, existingCostExcl: 10, receivedQty: 5, receivedCostExcl: 20 })))
  ok('keeps 4 decimals (a case of 24 at 199.99)',
    weightedAverageCost({ existingQty: 0, existingCostExcl: 0, receivedQty: 24, receivedCostExcl: 8.3329 }) === 8.3329)
  // Never NaN or Infinity, whatever it is fed.
  let bad = 0
  for (const q of [-10, -1, 0, 1, 7.5, 1000]) {
    for (const r of [0.001, 1, 12.5, 5000]) {
      const v = weightedAverageCost({ existingQty: q, existingCostExcl: 3.33, receivedQty: r, receivedCostExcl: 9.99 })
      if (!Number.isFinite(v) || v < 0) bad++
    }
  }
  ok('never produces NaN, Infinity or a negative cost', bad === 0, `${bad} bad results`)

  // ── Fixtures
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1")
    ?? await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, { code: `PUR${stamp}`, name: 'Purchase Test Wholesalers', paymentTermsDays: 30 })
  if (!sup.ok) { console.log('setup failed:', sup.error); process.exit(1) }

  // Baseline, so sequence integrity is measured across this run rather than
  // against whatever history the shared database already carries.
  const seqBefore = await verifySequence(SITE, 'grv')

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`, [`PP${stamp}`, `Purchase test item ${stamp}`])
  const productId = p.insertId

  // ── First receipt into empty stock
  const first = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `SI-${stamp}`,
    lines: [{ productId, productCode: `PP${stamp}`, supplierCode: 'THEIR-CODE-1', description: 'Purchase test item', productType: 'normal', qtyReceived: 100, unitCostExcl: 10, vatRatePct: rate }],
  })
  ok('*** first GRV posted ***', first.ok, first.ok ? first.documentNumber : first.error)
  if (!first.ok) process.exit(1)
  ok('  numbered from the GRV sequence', first.documentNumber.startsWith('GRV'), first.documentNumber)

  let state = await product(productId)
  ok('*** stock received: 0 -> 100 ***', toNum(state.stock_on_hand) === 100, String(state.stock_on_hand))
  ok('*** average_cost MOVED (0 -> 10) ***', toNum(state.average_cost) === 10, String(state.average_cost))
  ok('  last_cost set to what we paid', toNum(state.last_cost) === 10, String(state.last_cost))

  const moves = await listMovements(SITE, productId, 3)
  ok('  a receipt movement was written', moves[0]?.movementType === 'receipt' && moves[0]?.qtyChange === 100)

  const owed = await getSupplier(SITE, sup.id)
  ok('*** supplier ledger credited (we owe them) ***', owed!.balance > 0, String(owed!.balance))
  const expectedIncl = round(100 * 10 * (1 + rate / 100), 2)
  ok(`  by the VAT-inclusive total (${expectedIncl})`, Math.abs(owed!.balance - expectedIncl) < 0.02, String(owed!.balance))
  const ledger = await listSupplierLedger(SITE, sup.id)
  ok('  ledger entry has a due date from their terms', ledger[0]?.dueDate !== null, String(ledger[0]?.dueDate))
  ok('  and links back to the GRV', ledger[0]?.reference === first.documentNumber, String(ledger[0]?.reference))

  ok('  their code was remembered for next time',
    (await siteQueryOne<any>(SITE, 'SELECT supplier_code FROM product_suppliers WHERE product_id=? AND supplier_id=?', [productId, sup.id]))?.supplier_code === 'THEIR-CODE-1')

  // ── Second receipt at a higher cost: the blend
  const second = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `SI-${stamp}-2`,
    lines: [{ productId, description: 'Purchase test item', productType: 'normal', qtyReceived: 100, unitCostExcl: 20, vatRatePct: rate }],
  })
  ok('second GRV posted', second.ok, second.ok ? '' : second.error)
  state = await product(productId)
  ok('  stock now 200', toNum(state.stock_on_hand) === 200, String(state.stock_on_hand))
  ok('*** average blended to 15 (100@10 + 100@20) ***', toNum(state.average_cost) === 15, String(state.average_cost))
  ok('  last_cost is the LATEST, not the average', toNum(state.last_cost) === 20, String(state.last_cost))

  // ── Freight makes it LANDED cost
  const withFreight = await receiveGoods(SITE, actor, {
    supplierId: sup.id, supplierInvoiceNo: `SI-${stamp}-3`, chargesExcl: 100,
    lines: [{ productId, description: 'Purchase test item', productType: 'normal', qtyReceived: 100, unitCostExcl: 10, vatRatePct: rate }],
  })
  ok('GRV with freight posted', withFreight.ok, withFreight.ok ? '' : withFreight.error)
  const line = await siteQueryOne<any>(SITE,
    'SELECT unit_cost_excl, charge_excl, landed_cost_excl FROM purchase_document_lines WHERE document_id = ?',
    [withFreight.ok ? withFreight.documentId : 0])
  ok('*** landed cost = invoice 10 + freight 1 = 11 ***', toNum(line?.landed_cost_excl) === 11, `unit=${line?.unit_cost_excl} charge=${line?.charge_excl} landed=${line?.landed_cost_excl}`)
  state = await product(productId)
  // 200 @ 15 = 3000, plus 100 @ 11 = 1100 → 4100 / 300 = 13.6667
  ok('  average blended using the LANDED cost', toNum(state.average_cost) === 13.6667, String(state.average_cost))

  // ── Freight spread pro-rata, not evenly
  const twoLines = await receiveGoods(SITE, actor, {
    supplierId: sup.id, chargesExcl: 100,
    lines: [
      { productId, description: 'Big line', productType: 'normal', qtyReceived: 10, unitCostExcl: 90, vatRatePct: rate },
      { productId, description: 'Small line', productType: 'normal', qtyReceived: 10, unitCostExcl: 10, vatRatePct: rate },
    ],
  })
  if (twoLines.ok) {
    const rows = await siteQuery<any>(SITE, 'SELECT description, charge_excl FROM purchase_document_lines WHERE document_id = ? ORDER BY line_number', [twoLines.documentId])
    const big = toNum(rows[0]?.charge_excl), small = toNum(rows[1]?.charge_excl)
    ok('*** freight apportioned BY VALUE (90 / 10), not evenly ***', big === 90 && small === 10, `big=${big} small=${small}`)
    ok('  and the split sums to exactly the charge', round(big + small, 2) === 100)
  }

  // ── Validation
  ok('receipt with no lines refused', !(await receiveGoods(SITE, actor, { supplierId: sup.id, lines: [] })).ok)
  ok('zero quantity refused', !(await receiveGoods(SITE, actor, { supplierId: sup.id, lines: [{ productId, description: 'x', qtyReceived: 0, unitCostExcl: 5, vatRatePct: rate }] })).ok)
  ok('negative cost refused', !(await receiveGoods(SITE, actor, { supplierId: sup.id, lines: [{ productId, description: 'x', qtyReceived: 1, unitCostExcl: -5, vatRatePct: rate }] })).ok)
  ok('unknown supplier refused', !(await receiveGoods(SITE, actor, { supplierId: 999999, lines: [{ productId, description: 'x', qtyReceived: 1, unitCostExcl: 5, vatRatePct: rate }] })).ok)

  // ── The VAT period lock
  const today = new Date().toISOString().slice(0, 10)
  await setSetting(SITE, 'vat_period_locked_to', today)
  ok('*** locked VAT period REFUSES a receipt ***',
    !(await receiveGoods(SITE, actor, { supplierId: sup.id, lines: [{ productId, description: 'x', qtyReceived: 1, unitCostExcl: 5, vatRatePct: rate }] })).ok)
  await setSetting(SITE, 'vat_period_locked_to', '')

  // ── Void: stock back out, ledger reversed, cost deliberately NOT unwound
  const beforeVoid = await product(productId)
  const voided = await voidReceipt(SITE, actor, second.ok ? second.documentId : 0, 'Received in error')
  ok('*** same-day void accepted ***', voided.ok, voided.ok ? '' : voided.error)
  state = await product(productId)
  ok('  stock taken back out', toNum(state.stock_on_hand) === toNum(beforeVoid.stock_on_hand) - 100, `${beforeVoid.stock_on_hand} -> ${state.stock_on_hand}`)
  ok('  average cost deliberately NOT unwound', toNum(state.average_cost) === toNum(beforeVoid.average_cost), `${beforeVoid.average_cost} -> ${state.average_cost}`)
  ok('  double void refused', !(await voidReceipt(SITE, actor, second.ok ? second.documentId : 0, 'again')).ok)

  // ── The audit trail (139): a receipt that was received then voided carries
  // exactly two rows, in that order, each naming who did it.
  if (second.ok) {
    const trail = await siteQuery<any>(SITE,
      'SELECT action, user_name FROM purchase_document_audit WHERE document_id = ? ORDER BY id',
      [second.documentId])
    ok('*** audit trail: finalised then void ***',
      trail.length === 2 && trail[0].action === 'finalised' && trail[1].action === 'void',
      JSON.stringify(trail.map((t: any) => t.action)))
    ok('  each row names the actor', trail.every((t: any) => String(t.user_name).length > 0))
  }

  // ── Invariants
  ok('*** reconcileStock zero drift ***', (await reconcileStock(SITE)).length === 0, JSON.stringify(await reconcileStock(SITE)))
  ok('*** reconcileSupplierBalances zero drift ***', (await reconcileSupplierBalances(SITE)).length === 0)
  // Measured as a delta: this test deletes its own GRVs afterwards, which
  // leaves their numbers issued with nothing to show for them. The real
  // question is whether THIS run left a hole.
  const seq = await verifySequence(SITE, 'grv')
  ok('*** every GRV number this run issued has a document ***',
    seq.issued - seqBefore.issued === seq.live + seq.voided - (seqBefore.live + seqBefore.voided),
    `issued ${seq.issued - seqBefore.issued}, documents ${seq.live + seq.voided - (seqBefore.live + seqBefore.voided)}`)

  // ── Cleanup: documents before the supplier (FK is RESTRICT).
  const docs = await siteQuery<any>(SITE, 'SELECT id FROM purchase_documents WHERE supplier_id = ?', [sup.id])
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ? AND source IN (?,?)', [d.id, 'grv', 'cancelled'])
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE id = ?', [d.id])
  }
  await siteExecute(SITE, 'DELETE FROM supplier_allocations WHERE debit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?) OR credit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?)', [sup.id, sup.id])
  await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE supplier_id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [sup.id])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

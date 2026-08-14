/**
 * Batch / lot / expiry tracking — the per-lot analogue of serials.
 *
 * THE PROPERTY THIS EXISTS TO PROVE: the movement-layer hook is TOTAL. Every
 * stock change of a batch product — GRV, sale, return, void, adjustment,
 * transfer — maps to lot slices, so the invariants hold for every caller by
 * construction:
 *
 *   (T1/T2) lot sums equal the piles, per location
 *   (T3)    each lot equals the sum of its own slices
 *
 * The FEFO cases are the ones a shop pays for: the earliest expiry sells
 * first with no cashier involvement, an expired-only shelf still SELLS (the
 * shelf is authoritative over data typed at a receiving door) but is logged,
 * and a void puts quantity back into the exact lots it left.
 *
 *   npm run test:batches
 */
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../src/lib/siteDb'
import { createSupplier } from '../src/lib/site/suppliers'
import { createLocation } from '../src/lib/site/stockLocations'
import { receiveGoods, voidReceipt } from '../src/lib/site/purchasePosting'
import {
  listBatches,
  reconcileBatches,
  expiringSoon,
  batchTrace,
  seedUntrackedBatchesTx,
} from '../src/lib/site/batches'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { postNewAdjustment } from '../src/lib/site/stockAdjustments'
import { postTransfer } from '../src/lib/site/stockTransfers'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { offlineBlockedProduct } from '../src/lib/offlineCapability'
import { stockDirectionFor } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Batch Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZBT[0-9]{8}'
const TAG = 'ZBT test'

async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const docs = await siteQuery<any>(
    SITE, `SELECT id FROM sales_documents WHERE customer_name LIKE '${TAG}%'`)
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(SITE,
      "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source IN ('sale','sale_void') AND b.source_doc_id = ?", [d.id])
    await siteExecute(SITE,
      "DELETE FROM journal_batches WHERE source IN ('sale','sale_void') AND source_doc_id = ?", [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  // The adjustment and transfer documents this run posted reference the
  // products by FK, so their lines go first and any document left empty goes
  // with them — the same raw retirement test-stock-takes gives its posted
  // sheets. Their numbers become gaps; the sequence checks elsewhere are
  // relative, and these are scratch documents on a dev database.
  await siteExecute(SITE,
    `DELETE FROM stock_adjustment_lines WHERE product_id IN ${products}`)
  await siteExecute(SITE,
    `DELETE FROM stock_adjustments
      WHERE note LIKE 'ZBT %' AND NOT EXISTS
        (SELECT 1 FROM stock_adjustment_lines l WHERE l.adjustment_id = stock_adjustments.id)`)
  await siteExecute(SITE,
    `DELETE FROM stock_transfer_lines WHERE product_id IN ${products}`)
  await siteExecute(SITE,
    `DELETE FROM stock_transfers
      WHERE NOT EXISTS
        (SELECT 1 FROM stock_transfer_lines l WHERE l.transfer_id = stock_transfers.id)`)
  await siteExecute(SITE,
    `DELETE bm FROM batch_movements bm JOIN product_batches b ON b.id = bm.batch_id
      WHERE b.product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_batches WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_suppliers WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code LIKE 'ZB%' AND is_main = 0`)
}

const pile = async (productId: number, locationId: number) =>
  toNum((await siteQueryOne<any>(SITE,
    'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
    [productId, locationId]))?.stock_on_hand)

const lotQty = async (productId: number, batchNo: string) =>
  toNum((await siteQueryOne<any>(SITE,
    'SELECT SUM(qty_remaining) AS q FROM product_batches WHERE product_id=? AND batch_no=?',
    [productId, batchNo]))?.q)

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  ok('a batch product moves stock normally', stockDirectionFor('batch') === -1)
  ok('  and sells OFFLINE — allocation is server-side at sync',
    offlineBlockedProduct({ productType: 'batch' }) === null)

  /* ── Fixtures ────────────────────────────────────────────────────────── */

  const driftBefore = (await reconcileStock(SITE)).length
  const batchDriftBefore = (await reconcileBatches(SITE)).length
  const seqBefore = await siteQueryOne<any>(SITE,
    "SELECT next_number, last_issued_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'invoice'")

  const vat = (await siteQueryOne<any>(SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1")) ??
    (await siteQueryOne<any>(SITE,
      "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1"))
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `ZBSUP${stamp.slice(0, 4)}`, name: 'ZBT Perishables', paymentTermsDays: 30,
  })
  if (!sup.ok) { console.log('supplier setup failed:', sup.error); process.exit(1) }

  await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?, ?, 'batch', 0, 0)`,
    [`ZBT${stamp}`, `Yoghurt ${stamp}`])
  const yoghurt = Number((await siteQueryOne<any>(SITE,
    'SELECT id FROM products WHERE code=?', [`ZBT${stamp}`]))!.id)

  const mainLoc = Number((await siteQueryOne<any>(SITE,
    'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1'))!.id)

  const receive = (over: Record<string, unknown> = {}) =>
    receiveGoods(SITE, actor, {
      supplierId: sup.id,
      lines: [{
        productId: yoghurt, productCode: `ZBT${stamp}`, description: `Yoghurt ${stamp}`,
        productType: 'batch', qtyReceived: 10, unitCostExcl: 8, vatRatePct: rate,
        batchNo: 'LOT-A', expiryDate: '2027-01-15', ...over,
      }],
    })

  /* ── 1. Receipt creates the lot ──────────────────────────────────────── */

  const noData = await receive({ batchNo: null, expiryDate: null })
  ok('*** a batch line with no lot data is refused, leaving nothing ***',
    !noData.ok, noData.ok ? 'it posted' : noData.error)
  ok('  no stock moved', (await pile(yoghurt, mainLoc)) === 0)
  ok('  no lot rows appeared',
    (await siteQuery<any>(SITE, 'SELECT id FROM product_batches WHERE product_id=?', [yoghurt])).length === 0)

  const grvA = await receive({})
  ok('*** a receipt with lot data posts ***', grvA.ok, grvA.ok ? '' : grvA.error)
  if (!grvA.ok) { console.log('cannot continue'); process.exit(1) }
  ok('  the lot holds what arrived', (await lotQty(yoghurt, 'LOT-A')) === 10)

  const reReceive = await receive({ qtyReceived: 5 })
  ok('  re-receiving the same lot adds to it',
    reReceive.ok && (await lotQty(yoghurt, 'LOT-A')) === 15)

  const wrongExpiry = await receive({ qtyReceived: 3, expiryDate: '2028-06-01' })
  ok('*** the same lot with a DIFFERENT expiry is refused by name ***',
    !wrongExpiry.ok && /mislabelled/i.test(wrongExpiry.ok ? '' : wrongExpiry.error),
    wrongExpiry.ok ? 'it posted' : wrongExpiry.error)

  // A second, EARLIER-expiring lot: the one FEFO must take first.
  const grvB = await receive({ batchNo: 'LOT-B', expiryDate: '2026-09-01', qtyReceived: 6, unitCostExcl: 7 })
  ok('a second lot with an earlier expiry arrives', grvB.ok, grvB.ok ? '' : grvB.error)

  ok('*** T1/T2 hold after the receipts ***',
    (await reconcileBatches(SITE)).length === batchDriftBefore &&
      (await pile(yoghurt, mainLoc)) === 21)

  /* ── 2. FEFO at the till ─────────────────────────────────────────────── */

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('CASH tender missing.')

  const sell = async (qty: number) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: `${TAG} ${stamp}`,
      lines: [{
        productId: yoghurt, productCode: `ZBT${stamp}`, description: `Yoghurt ${stamp}`,
        productType: 'batch', qty, unitPriceIncl: 15, vatRatePct: rate, unitCostExcl: 8,
      }],
    } as never)
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, {
      documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount: qty * 15 }],
    })
  }

  const sale1 = await sell(4)
  ok('*** a sale allocates from the EARLIEST expiry, untouched by the cashier ***',
    sale1.ok && (await lotQty(yoghurt, 'LOT-B')) === 2 && (await lotQty(yoghurt, 'LOT-A')) === 15,
    sale1.ok ? `B=${await lotQty(yoghurt, 'LOT-B')} A=${await lotQty(yoghurt, 'LOT-A')}` : sale1.error)

  const sale2 = await sell(5)
  ok('*** a sale larger than the earliest lot spans lots FEFO ***',
    sale2.ok && (await lotQty(yoghurt, 'LOT-B')) === 0 && (await lotQty(yoghurt, 'LOT-A')) === 12,
    sale2.ok ? `B=${await lotQty(yoghurt, 'LOT-B')} A=${await lotQty(yoghurt, 'LOT-A')}` : sale2.error)

  /* ── 3. Void returns to the exact lots ───────────────────────────────── */

  const voidReason = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!voidReason) throw new Error('Seeded void reason missing — run 102.')
  if (sale2.ok) {
    const undone = await voidDocument(SITE, actor, sale2.documentId, {
      reasonId: voidReason.id, note: 'ZBT void',
    })
    ok('*** voiding the spanning sale refills the exact lots it took ***',
      undone.ok && (await lotQty(yoghurt, 'LOT-B')) === 2 && (await lotQty(yoghurt, 'LOT-A')) === 15,
      `B=${await lotQty(yoghurt, 'LOT-B')} A=${await lotQty(yoghurt, 'LOT-A')}`)
  }

  /* ── 4. Expired stock still sells, loudly ────────────────────────────── */

  await siteExecute(SITE,
    "UPDATE product_batches SET expiry_date = '2020-01-01' WHERE product_id = ? AND batch_no = 'LOT-B'",
    [yoghurt])
  const logMaxBefore = Number((await siteQueryOne<any>(SITE,
    "SELECT COALESCE(MAX(id),0) AS m FROM activity_log WHERE action = 'expired_stock_sold'"))?.m ?? 0)

  const sale3 = await sell(3)
  ok('*** with only expired stock in the earliest lot, the sale still POSTS ***',
    sale3.ok, sale3.ok ? '' : sale3.error)
  ok('  non-expired stock was taken FIRST — the expired lot untouched while fresh remains',
    (await lotQty(yoghurt, 'LOT-B')) === 2 && (await lotQty(yoghurt, 'LOT-A')) === 12,
    `B=${await lotQty(yoghurt, 'LOT-B')} A=${await lotQty(yoghurt, 'LOT-A')}`)

  // Drain LOT-A so the next sale has nothing but the expired LOT-B.
  const sale4 = await sell(12)
  ok('LOT-A drains', sale4.ok && (await lotQty(yoghurt, 'LOT-A')) === 0)
  const sale5 = await sell(2)
  const logged = await siteQueryOne<any>(SITE,
    "SELECT id FROM activity_log WHERE action = 'expired_stock_sold' AND id > ? LIMIT 1", [logMaxBefore])
  ok('*** a sale forced onto expired stock posts AND is logged ***',
    sale5.ok && logged !== null && (await lotQty(yoghurt, 'LOT-B')) === 0,
    sale5.ok ? (logged ? '' : 'no log row') : sale5.error)

  /* ── 5. Oversell lands on the untracked bucket, visibly ──────────────── */

  const sale6 = await sell(3)
  ok('*** an oversell still posts — the shelf is authoritative ***', sale6.ok)
  const bucket = await siteQueryOne<any>(SITE,
    "SELECT qty_remaining FROM product_batches WHERE product_id=? AND batch_no=''", [yoghurt])
  ok('  and the bucket shows the negative rather than hiding it',
    toNum(bucket?.qty_remaining) === -3, String(bucket?.qty_remaining))
  ok('  T2 still holds — the bucket is IN the invariant',
    (await reconcileBatches(SITE)).length === batchDriftBefore)

  /* ── 6. Adjustments: automatic spread, and the exact-lot write-off ───── */

  // Put stock back: 6 into LOT-C, plus the bucket's -3 still standing.
  const grvC = await receive({ batchNo: 'LOT-C', expiryDate: '2026-12-01', qtyReceived: 6 })
  ok('a third lot arrives', grvC.ok)

  const adjReason = await siteQueryOne<any>(SITE,
    'SELECT id FROM stock_adjustment_reasons ORDER BY sort_order, id LIMIT 1')
  if (!adjReason) throw new Error('No adjustment reasons seeded — run 100.')

  const upAdj = await postNewAdjustment(SITE, actor, {
    locationId: mainLoc,
    reasonId: Number(adjReason.id),
    note: 'ZBT write-on',
    lines: [{
      productId: yoghurt, productCode: `ZBT${stamp}`, description: `Yoghurt ${stamp}`,
      qtyChange: 3, unitCostExcl: 8,
    }],
  })
  ok('*** a write-on with no lot lands on the NEWEST lot ***',
    upAdj.ok && (await lotQty(yoghurt, 'LOT-C')) === 9,
    upAdj.ok ? `C=${await lotQty(yoghurt, 'LOT-C')}` : upAdj.error)

  const lotC = await siteQueryOne<any>(SITE,
    "SELECT id FROM product_batches WHERE product_id=? AND batch_no='LOT-C'", [yoghurt])
  const exact = await postNewAdjustment(SITE, actor, {
    locationId: mainLoc,
    reasonId: Number(adjReason.id),
    note: 'ZBT recall',
    lines: [{
      productId: yoghurt, productCode: `ZBT${stamp}`, description: `Yoghurt ${stamp}`,
      qtyChange: -4, unitCostExcl: 8, batchId: Number(lotC!.id),
    }],
  })
  ok('*** a write-off NAMING a lot hits only that lot — the recall path ***',
    exact.ok && (await lotQty(yoghurt, 'LOT-C')) === 5,
    exact.ok ? `C=${await lotQty(yoghurt, 'LOT-C')}` : exact.error)

  /* ── 7. Transfers carry lot identity ─────────────────────────────────── */

  const room = await createLocation(SITE, { code: `ZB${stamp.slice(0, 6)}`, name: 'ZBT store room' })
  if (!room.ok) { console.log('location failed'); process.exit(1) }

  const moved = await postTransfer(SITE, actor, {
    fromLocationId: mainLoc,
    toLocationId: room.id,
    lines: [{ productId: yoghurt, productCode: `ZBT${stamp}`, description: `Yoghurt ${stamp}`, qty: 2 }],
  })
  ok('*** a transfer moves the lot IDENTITY with the goods ***',
    moved.ok, moved.ok ? '' : moved.error)
  const atRoom = await siteQueryOne<any>(SITE,
    `SELECT batch_no, qty_remaining FROM product_batches
      WHERE product_id=? AND location_id=? AND batch_no <> ''`, [yoghurt, room.id])
  ok('  the destination gained the same lot number',
    atRoom !== null && String(atRoom.batch_no) === 'LOT-C' && toNum(atRoom.qty_remaining) === 2,
    JSON.stringify(atRoom))
  ok('  per-location T2 holds on both sides',
    (await reconcileBatches(SITE)).length === batchDriftBefore)

  /* ── 8. GRV void backs out its lots — unless they sold ───────────────── */

  const grvD = await receive({ batchNo: 'LOT-D', expiryDate: '2027-06-01', qtyReceived: 4 })
  ok('a fourth lot arrives', grvD.ok)
  if (grvD.ok) {
    const undone = await voidReceipt(SITE, actor, grvD.documentId, 'ZBT wrong delivery')
    ok('*** voiding the receipt removes the lot it created ***',
      undone.ok && (await lotQty(yoghurt, 'LOT-D')) === 0,
      undone.ok ? '' : undone.error)
    ok('  and the lot row itself is gone — born of the void, gone with it',
      (await siteQueryOne<any>(SITE,
        "SELECT id FROM product_batches WHERE product_id=? AND batch_no='LOT-D'", [yoghurt])) === null)
  }

  const grvE = await receive({ batchNo: 'LOT-E', expiryDate: '2027-06-01', qtyReceived: 4 })
  if (grvE.ok) {
    await sell(8) // spans LOT-C remainder and eats into LOT-E
    const refused = await voidReceipt(SITE, actor, grvE.documentId, 'ZBT too late')
    ok('*** voiding a receipt whose lot has partly SOLD is refused ***',
      !refused.ok && /supplier return/i.test(refused.ok ? '' : refused.error),
      refused.ok ? 'it voided' : refused.error)
  }

  /* ── 9. Conversion seeds the bucket ──────────────────────────────────── */

  await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?, ?, 'normal', 0, 0)`,
    [`ZBT${stamp}2`, `Converted ${stamp}`])
  const converted = Number((await siteQueryOne<any>(SITE,
    'SELECT id FROM products WHERE code=?', [`ZBT${stamp}2`]))!.id)
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,7)',
    [converted, mainLoc])
  await siteExecute(SITE, 'UPDATE products SET stock_on_hand = 7 WHERE id = ?', [converted])
  // The opening movement, so reconcileStock's own invariant stays whole.
  await siteExecute(SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                  unit_cost_excl, source, user_id, user_name)
     VALUES (?,?,'opening',7,7,0,'opening',1,'Batch Test')`,
    [converted, mainLoc])

  await siteTransaction(SITE, (tx) => seedUntrackedBatchesTx(tx, actor, converted))
  await siteExecute(SITE, "UPDATE products SET product_type = 'batch' WHERE id = ?", [converted])
  const seeded = await siteQueryOne<any>(SITE,
    "SELECT qty_remaining FROM product_batches WHERE product_id=? AND batch_no=''", [converted])
  ok('*** a product converted with stock on hand seeds the bucket — T1 from day one ***',
    toNum(seeded?.qty_remaining) === 7 && (await reconcileBatches(SITE)).length === batchDriftBefore,
    String(seeded?.qty_remaining))

  /* ── 10. The reads ───────────────────────────────────────────────────── */

  const expiring = await expiringSoon(SITE, 36500)
  ok('expiringSoon finds the dated lots, earliest first',
    expiring.some((b) => b.productId === yoghurt))

  const traceLot = await siteQueryOne<any>(SITE,
    "SELECT id FROM product_batches WHERE product_id=? AND batch_no='LOT-C' AND location_id=?",
    [yoghurt, mainLoc])
  if (traceLot) {
    const trace = await batchTrace(SITE, Number(traceLot.id))
    ok('*** batchTrace shows the GRV in and the sales out ***',
      trace !== null &&
        trace.batch.receivedDocNumber !== null &&
        trace.events.some((e) => e.action === 'receipt') &&
        trace.events.some((e) => e.qty < 0),
      trace ? `${trace.events.length} events` : 'no trace')
  }

  /* ── 11. The invariants, at the end of all of it ─────────────────────── */

  ok('*** reconcileBatches is clean after every path above ***',
    (await reconcileBatches(SITE)).length === batchDriftBefore)
  ok('*** reconcileStock is clean too ***',
    (await reconcileStock(SITE)).length === driftBefore)

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  if (seqBefore) {
    await siteExecute(SITE,
      "UPDATE document_sequences SET next_number = ?, last_issued_number = ? WHERE terminal_id = 0 AND doc_type = 'invoice'",
      [seqBefore.next_number, seqBefore.last_issued_number])
  }
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll batch checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

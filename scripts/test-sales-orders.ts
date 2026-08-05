/**
 * Sales orders — commitment, partial delivery, and the reservation invariant.
 *
 * The rule that matters most: a reservation MOVES NOTHING. An order for 10
 * must leave stock_on_hand untouched and Σ stock_movements.qty_change still
 * equal to it, while "available to sell" drops by 10. If a reservation ever
 * writes a stock movement, that invariant breaks and the reconciliation report
 * — the thing that proves this module works — becomes worthless.
 *
 *   npm run test:sales-orders
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { createCustomer } from '../src/lib/site/customers'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  setOrderDetails, getOrder, deliverOrder, cancelOrder,
  releaseStaleReservations, listOrders, refreshFulfilment,
} from '../src/lib/site/salesOrders'
import {
  reconcileStock, reservedQty, availableToSell, reservedQtyFor,
} from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Order Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const stockOf = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [id]))?.stock_on_hand)

/** yyyy-mm-dd, n days from now (negative = past). */
function daysOut(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const p = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',100,20,20,?,1)`,
    [`ORD${stamp}`, `Order test ${stamp}`, vat?.id ?? null])
  const productId = p.insertId
  await siteExecute(SITE,
    "INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_id, user_name) VALUES (?,(SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1),'opening',100,100,20,'opening',1,'Order Test')",
    [productId])
  await siteExecute(SITE,
    'INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=? ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)',
    [productId])

  const cust = await createCustomer(SITE, actor, { code: `ORC${stamp}`, name: 'Order Test Co', creditLimit: 50000, paymentTermsDays: 30 })
  const account = await getTenderByCode(SITE, 'ACCOUNT')
  if (!cust.ok || !account) { console.log('setup failed'); process.exit(1) }

  const driftBefore = (await reconcileStock(SITE)).length

  // ── An order for 10 at 230 incl
  const draft = await saveDraft(SITE, actor, {
    docType: 'sales_order', customerId: cust.id, customerName: 'Order Test Co',
    lines: [{ productId, productCode: `ORD${stamp}`, description: 'Order test item', productType: 'normal', qty: 10, unitPriceIncl: 230, vatRatePct: rate, unitCostExcl: 20 }],
  })
  ok('order draft saved', draft.ok, draft.ok ? `#${draft.id}` : draft.error)
  if (!draft.ok) process.exit(1)
  const orderId = draft.id

  ok('an order has no document number yet', (await getDocument(SITE, orderId))?.documentNumber === null)

  const details = await setOrderDetails(SITE, orderId, {
    deliveryDate: daysOut(7), customerOrderNo: `PO-${stamp}`, expiresAt: daysOut(30),
  })
  ok('delivery details attached', details.ok, details.ok ? '' : details.error)

  ok('expiry before delivery refused',
    !(await setOrderDetails(SITE, orderId, { deliveryDate: daysOut(10), expiresAt: daysOut(2) })).ok)
  ok('a bad date is refused', !(await setOrderDetails(SITE, orderId, { deliveryDate: 'soon' })).ok)

  // ── THE INVARIANT: the order reserves, but moves nothing
  ok('*** stock_on_hand UNCHANGED by an order ***', (await stockOf(productId)) === 100, String(await stockOf(productId)))
  ok('*** Σ movements still equals stock_on_hand ***', (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} drift rows`)
  ok('*** 10 is reserved ***', (await reservedQty(SITE, productId)) === 10, String(await reservedQty(SITE, productId)))

  const avail = await availableToSell(SITE, [productId])
  ok('*** available to sell dropped to 90 ***', avail.get(productId)?.available === 90, String(avail.get(productId)?.available))
  ok('  on hand still reads 100 beside it', avail.get(productId)?.onHand === 100)

  const bulk = await reservedQtyFor(SITE, [productId, 999999])
  ok('bulk reserved lookup agrees', bulk.get(productId) === 10)
  ok('  and omits products with nothing reserved', !bulk.has(999999))

  // ── Validation before delivering
  const lineId = (await getDocument(SITE, orderId))!.lines[0].id
  ok('delivering more than ordered refused',
    !(await deliverOrder(SITE, actor, orderId, [{ lineId, qty: 11 }])).ok)
  ok('a negative delivery refused',
    !(await deliverOrder(SITE, actor, orderId, [{ lineId, qty: -1 }])).ok)
  ok('nothing to deliver refused',
    !(await deliverOrder(SITE, actor, orderId, [{ lineId, qty: 0 }])).ok)
  ok('an unknown line refused',
    !(await deliverOrder(SITE, actor, orderId, [{ lineId: 999999, qty: 1 }])).ok)

  ok('an order cannot be finalised — it is not a tax document',
    !(await finaliseDocument(SITE, actor, { documentId: orderId, customerId: cust.id, tenders: [{ tenderTypeId: account.id, amount: 2300 }] })).ok)

  // ── Deliver 4 of 10
  const first = await deliverOrder(SITE, actor, orderId, [{ lineId, qty: 4 }])
  ok('*** delivered 4 — a linked invoice was raised ***', first.ok, first.ok ? `invoice #${first.invoiceId}` : first.error)
  if (!first.ok) process.exit(1)

  ok('  the order reads part_delivered', first.fulfilmentStatus === 'part_delivered', first.fulfilmentStatus)

  const inv = await getDocument(SITE, first.invoiceId)
  ok('  the invoice is a draft, not yet posted', inv?.status === 'draft')
  ok('  it links back to the order', inv?.convertedFromId === orderId, String(inv?.convertedFromId))
  ok('  for 4, not 10', inv?.lines[0].qty === 4, String(inv?.lines[0].qty))
  ok('*** priced at the ORDER price, not today’s ***', inv?.lines[0].unitPriceIncl === 230, String(inv?.lines[0].unitPriceIncl))
  ok('  totalling 920 incl', inv?.totalIncl === 920, String(inv?.totalIncl))
  ok('  and it balances', Math.abs((inv!.subtotalExcl + inv!.vatTotal) - inv!.totalIncl) < 0.005,
    `${inv?.subtotalExcl}+${inv?.vatTotal} vs ${inv?.totalIncl}`)

  // Still nothing has moved: the invoice is a DRAFT.
  ok('*** an undelivered draft still moves no stock ***', (await stockOf(productId)) === 100, String(await stockOf(productId)))
  ok('  reservation shrank to 6', (await reservedQty(SITE, productId)) === 6, String(await reservedQty(SITE, productId)))

  const afterFirst = await getOrder(SITE, orderId)
  ok('  order says 4 delivered, 6 outstanding',
    afterFirst?.qtyDelivered === 4 && afterFirst?.qtyOutstanding === 6,
    `${afterFirst?.qtyDelivered}/${afterFirst?.qtyOutstanding}`)
  ok('  and lists the delivery', afterFirst?.deliveries.length === 1)

  // ── Finalising the delivery invoice DOES move stock
  const posted = await finaliseDocument(SITE, actor, {
    documentId: first.invoiceId, customerId: cust.id,
    tenders: [{ tenderTypeId: account.id, amount: 920 }],
  })
  ok('*** the delivery invoice finalises normally ***', posted.ok, posted.ok ? posted.documentNumber : posted.error)
  ok('  NOW stock moved: 96 left', (await stockOf(productId)) === 96, String(await stockOf(productId)))
  ok('*** Σ movements STILL equals stock_on_hand ***', (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} drift rows`)

  const avail2 = await availableToSell(SITE, [productId])
  ok('  available = 96 on hand − 6 reserved = 90', avail2.get(productId)?.available === 90, String(avail2.get(productId)?.available))

  // ── A part-delivered order can no longer be edited
  const edit = await saveDraft(SITE, actor, {
    docType: 'sales_order', customerId: cust.id, customerName: 'Order Test Co',
    lines: [{ productId, productCode: `ORD${stamp}`, description: 'Changed', productType: 'normal', qty: 99, unitPriceIncl: 230, vatRatePct: rate, unitCostExcl: 20 }],
  }, orderId)
  ok('*** a part-delivered order refuses edits ***', !edit.ok, !edit.ok ? edit.error : '')
  ok('  and qty_delivered survived', (await getOrder(SITE, orderId))?.qtyDelivered === 4)

  // ── Deliver the remaining 6
  const second = await deliverOrder(SITE, actor, orderId, [{ lineId, qty: 6 }])
  ok('*** delivered the remaining 6 ***', second.ok, second.ok ? `invoice #${second.invoiceId}` : second.error)
  ok('  the order is now delivered in full', second.ok && second.fulfilmentStatus === 'delivered')
  ok('  nothing is reserved any more', (await reservedQty(SITE, productId)) === 0, String(await reservedQty(SITE, productId)))
  ok('  two invoices against one order', (await getOrder(SITE, orderId))?.deliveries.length === 2)
  ok('  delivering again is refused', !(await deliverOrder(SITE, actor, orderId, [{ lineId, qty: 1 }])).ok)
  ok('  a delivered order cannot be cancelled', !(await cancelOrder(SITE, actor, orderId)).ok)

  if (second.ok) {
    const p2 = await finaliseDocument(SITE, actor, {
      documentId: second.invoiceId, customerId: cust.id,
      tenders: [{ tenderTypeId: account.id, amount: 1380 }],
    })
    ok('  the second delivery posts too', p2.ok, p2.ok ? p2.documentNumber : p2.error)
    ok('*** all 10 have now left: 90 on hand ***', (await stockOf(productId)) === 90, String(await stockOf(productId)))
    ok('*** and the invariant STILL holds ***', (await reconcileStock(SITE)).length === driftBefore)
  }

  // ── Cancelling releases a reservation without reversing anything
  const cancelDraft = await saveDraft(SITE, actor, {
    docType: 'sales_order', customerId: cust.id, customerName: 'Order Test Co',
    lines: [{ productId, productCode: `ORD${stamp}`, description: 'To cancel', productType: 'normal', qty: 25, unitPriceIncl: 230, vatRatePct: rate, unitCostExcl: 20 }],
  })
  if (!cancelDraft.ok) { console.log('cancel setup failed'); process.exit(1) }
  await setOrderDetails(SITE, cancelDraft.id, { deliveryDate: daysOut(5) })
  ok('a second order reserves 25', (await reservedQty(SITE, productId)) === 25, String(await reservedQty(SITE, productId)))

  const cancelled = await cancelOrder(SITE, actor, cancelDraft.id, 'Customer changed their mind')
  ok('*** cancelled, releasing 25 ***', cancelled.ok, cancelled.ok ? String(cancelled.released) : cancelled.error)
  ok('  the reservation is gone', (await reservedQty(SITE, productId)) === 0, String(await reservedQty(SITE, productId)))
  ok('*** cancelling reversed NOTHING — stock untouched ***', (await stockOf(productId)) === 90, String(await stockOf(productId)))
  ok('  Σ movements still clean', (await reconcileStock(SITE)).length === driftBefore)
  ok('  cancelling twice refused', !(await cancelOrder(SITE, actor, cancelDraft.id)).ok)
  ok('  a cancelled order refuses delivery',
    !(await deliverOrder(SITE, actor, cancelDraft.id, [{ lineId: (await getDocument(SITE, cancelDraft.id))!.lines[0].id, qty: 1 }])).ok)
  ok('  and refreshFulfilment leaves it cancelled', (await refreshFulfilment(SITE, cancelDraft.id)) === 'cancelled')

  // ── Stale reservations expire
  const staleDraft = await saveDraft(SITE, actor, {
    docType: 'sales_order', customerId: cust.id, customerName: 'Order Test Co',
    lines: [{ productId, productCode: `ORD${stamp}`, description: 'Forgotten', productType: 'normal', qty: 12, unitPriceIncl: 230, vatRatePct: rate, unitCostExcl: 20 }],
  })
  if (!staleDraft.ok) { console.log('stale setup failed'); process.exit(1) }
  await setOrderDetails(SITE, staleDraft.id, { expiresAt: daysOut(-1) })
  ok('a forgotten order reserves 12', (await reservedQty(SITE, productId)) === 12, String(await reservedQty(SITE, productId)))

  const released = await releaseStaleReservations(SITE, actor)
  ok('*** the stale reservation was released ***', released.some((r) => r.documentId === staleDraft.id),
    `${released.length} released`)
  ok('  stock is claimable again', (await reservedQty(SITE, productId)) === 0, String(await reservedQty(SITE, productId)))
  ok('*** but the order still EXISTS — the promise is not deleted ***',
    (await getOrder(SITE, staleDraft.id)) !== null)
  ok('  and it is still open, just not reserving',
    (await getOrder(SITE, staleDraft.id))?.details?.fulfilmentStatus === 'open')
  ok('  a released order can still be delivered',
    (await deliverOrder(SITE, actor, staleDraft.id, [{ lineId: (await getDocument(SITE, staleDraft.id))!.lines[0].id, qty: 1 }])).ok)
  ok('  releasing again finds nothing new',
    !(await releaseStaleReservations(SITE, actor)).some((r) => r.documentId === staleDraft.id))

  // ── Listing
  const list = await listOrders(SITE, { customerId: cust.id })
  ok('listOrders returns this customer’s orders', list.items.length === 3, `${list.items.length} of ${list.total}`)
  const outstanding = await listOrders(SITE, { fulfilment: 'outstanding', customerId: cust.id })
  ok('  outstanding excludes delivered and cancelled', outstanding.items.length === 1, String(outstanding.items.length))
  const byRef = await listOrders(SITE, { q: `PO-${stamp}` })
  ok('  searchable by the customer’s own order number', byRef.items.length === 1, String(byRef.items.length))
  ok('  a listed order carries its outstanding qty',
    list.items.find((o) => o.id === orderId)?.qtyOutstanding === 0)

  // ── Final invariant
  ok('*** reconcileStock clean at the end ***', (await reconcileStock(SITE)).length === driftBefore,
    `${(await reconcileStock(SITE)).length} drift rows`)

  // ── Cleanup: documents, movements, then the product and customer.
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, "DELETE FROM sales_tenders WHERE document_id IN (SELECT id FROM sales_documents WHERE customer_id = ?)", [cust.id])
  await siteExecute(SITE, "DELETE FROM customer_allocations WHERE debit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?) OR credit_txn_id IN (SELECT id FROM customer_transactions WHERE customer_id = ?)", [cust.id, cust.id])
  await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE customer_id = ?', [cust.id])
  // Deliveries reference their order, so clear the links before deleting.
  await siteExecute(SITE, 'UPDATE sales_documents SET converted_from_id = NULL WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [cust.id])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()

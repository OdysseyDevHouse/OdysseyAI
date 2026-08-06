/**
 * Online order queue checks against a live site database.
 *
 * The thing worth testing is ACCEPTANCE: it writes a real sales_document, so a
 * mistake here puts a wrong invoice in front of a customer. Everything below
 * exists because it is a way that could go wrong —
 *
 *   re-pricing silently producing R0.00 lines (it did, once);
 *   a double-click writing two sales for one order;
 *   cancelling leaving an orphan draft in the unposted list;
 *   "Out for delivery" being offered on a collection.
 *
 *   npm run test:online-orders
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { listOrderStatuses } from '../src/lib/site/onlineStore'
import {
  acceptOrder,
  archiveOrder,
  cancelOrder,
  getOrder,
  listOrders,
  moveOrderStatus,
  orderCounts,
} from '../src/lib/site/onlineOrders'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Queue Test' }
/** Every row this test makes carries this prefix, so cleanup can find them. */
const TAG = '__TEST_OO__'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * An order for two real products, deliberately priced at R1.00 — a price they
 * certainly do not have — so acceptance has to report a re-pricing.
 */
async function seedOrder(suffix: string, fulfilment: 'collect' | 'deliver' = 'collect') {
  const statuses = await listOrderStatuses(SITE)
  const isNew = statuses.find((s) => s.role === 'new')!

  const products = await siteQuery<{ id: number; code: string; description: string }>(
    SITE,
    `SELECT p.id, p.code, p.description
       FROM products p
       JOIN product_prices pp ON pp.product_id = p.id AND pp.selling_price_incl > 0
      WHERE p.is_archived = 0 AND p.product_type = 'normal'
      LIMIT 2`,
  )
  if (products.length < 2) throw new Error('Need two priced products to test against.')

  const result = await siteExecute(
    SITE,
    `INSERT INTO online_orders
       (order_number, status_id, fulfilment, contact_name, contact_phone,
        total_incl, delivery_fee_incl, delivery_suburb)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      `${TAG}${suffix}`,
      isNew.id,
      fulfilment,
      'Test Shopper',
      '0821234567',
      4,
      fulfilment === 'deliver' ? 35 : 0,
      fulfilment === 'deliver' ? 'Claremont' : '',
    ],
  )

  let n = 1
  for (const p of products) {
    await siteExecute(
      SITE,
      `INSERT INTO online_order_lines
         (order_id, line_number, product_id, product_code, description, qty, unit_price_incl, line_total_incl)
       VALUES (?,?,?,?,?,?,?,?)`,
      [result.insertId, n++, p.id, p.code, `${p.description} (as ordered)`, 2, 1.0, 2.0],
    )
  }
  return { orderId: result.insertId, products }
}

/** Removes every row this test could have created, whenever it is called. */
async function cleanup() {
  const orders = await siteQuery<{ id: number; document_id: number | null }>(
    SITE,
    `SELECT id, document_id FROM online_orders WHERE order_number LIKE ?`,
    [`${TAG}%`],
  )
  await siteExecute(SITE, `UPDATE online_orders SET document_id = NULL WHERE order_number LIKE ?`, [
    `${TAG}%`,
  ])
  for (const o of orders) {
    if (o.document_id) {
      await siteExecute(SITE, `DELETE FROM sales_documents WHERE id = ? AND status = 'draft'`, [
        o.document_id,
      ])
    }
  }
  await siteExecute(SITE, `DELETE FROM online_orders WHERE order_number LIKE ?`, [`${TAG}%`])
  return orders.length
}

async function main() {
  // A previous crashed run must not fail this one on the unique order number.
  await cleanup()

  console.log('\n— Accepting an order writes a real draft sale —')
  const { orderId } = await seedOrder('A')
  const accepted = await acceptOrder(SITE, orderId, ACTOR)
  ok('accept succeeds', accepted.ok, accepted.ok ? '' : accepted.error)
  if (!accepted.ok) {
    await cleanup()
    process.exit(1)
  }

  const doc = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT id, doc_type, status, reference, total_incl, customer_name
       FROM sales_documents WHERE id = ?`,
    [accepted.documentId],
  )
  ok('a sales_document exists', !!doc)
  ok('it is a DRAFT, not a posted invoice', String(doc?.status) === 'draft', String(doc?.status))
  ok('it is an invoice', String(doc?.doc_type) === 'invoice')
  ok('it references the order number', String(doc?.reference).startsWith(TAG))
  ok('the shopper is named on it', String(doc?.customer_name) === 'Test Shopper')

  const saleLines = await siteQuery<Record<string, unknown>>(
    SITE,
    `SELECT description, qty, unit_price_incl, vat_rate_pct FROM sales_document_lines
      WHERE document_id = ?`,
    [accepted.documentId],
  )
  ok('every ordered line reached the sale', saleLines.length === 2, `${saleLines.length}`)
  // The bug this test was written for: a missed price-structure join produced
  // R0.00 lines and the sale was written anyway.
  ok(
    'NO line was written at zero',
    saleLines.every((l) => toNum(l.unit_price_incl) > 0),
    saleLines.map((l) => toNum(l.unit_price_incl)).join(', '),
  )
  ok(
    'lines carry a real VAT rate',
    saleLines.every((l) => toNum(l.vat_rate_pct) >= 0),
  )
  ok('the sale total is not zero', toNum(doc?.total_incl) > 0, String(doc?.total_incl))

  console.log('\n— The customer is told what changed —')
  ok('re-pricing is reported', accepted.repriced.length === 2, `${accepted.repriced.length}`)
  ok(
    'each reports the old and the new price',
    accepted.repriced.every((r) => r.wasIncl === 1 && (r.nowIncl ?? 0) > 0),
  )
  ok(
    'the sale used TODAY’s price, not the basket’s',
    saleLines.every((l) => toNum(l.unit_price_incl) !== 1),
  )

  const moved = await getOrder(SITE, orderId)
  ok('the order left the "new" step', moved?.statusRole !== 'new', moved?.statusName)
  ok('the sale is linked to the order', moved?.documentId === accepted.documentId)

  console.log('\n— Accepting twice cannot write a second sale —')
  const again = await acceptOrder(SITE, orderId, ACTOR)
  ok('the second accept succeeds', again.ok)
  ok('it reports the order was already accepted', again.ok && again.alreadyAccepted)
  ok('and returns the SAME sale', again.ok && again.documentId === accepted.documentId)
  const saleCount = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE reference = ?`,
    [`${TAG}A`],
  )
  ok('exactly one sale exists for the order', Number(saleCount?.n) === 1, `${saleCount?.n}`)

  console.log('\n— Delivery —')
  const delivery = await seedOrder('B', 'deliver')
  const acceptedDelivery = await acceptOrder(SITE, delivery.orderId, ACTOR)
  ok('a delivery order accepts', acceptedDelivery.ok)
  if (acceptedDelivery.ok) {
    const lines = await siteQuery<Record<string, unknown>>(
      SITE,
      `SELECT description, unit_price_incl FROM sales_document_lines WHERE document_id = ?`,
      [acceptedDelivery.documentId],
    )
    const fee = lines.find((l) => String(l.description) === 'Delivery')
    ok('the delivery fee is charged as a line', !!fee)
    ok('at the quoted fee', toNum(fee?.unit_price_incl) === 35, String(fee?.unit_price_incl))
  }

  console.log('\n— Steps that do not apply are refused —')
  const statuses = await listOrderStatuses(SITE)
  const dispatched = statuses.find((s) => s.role === 'dispatched')
  if (dispatched) {
    const wrong = await moveOrderStatus(SITE, orderId, dispatched.id)
    ok('"out for delivery" is refused on a collection', !wrong.ok, wrong.ok ? '' : wrong.error)
  } else {
    console.log('SKIP  no dispatched status in this pipeline')
  }
  const cancelledStatus = statuses.find((s) => s.role === 'cancelled')!
  const viaMove = await moveOrderStatus(SITE, orderId, cancelledStatus.id)
  ok('cancelling via a plain move is refused', !viaMove.ok)

  console.log('\n— Cancelling —')
  const third = await seedOrder('C')
  const acceptedThird = await acceptOrder(SITE, third.orderId, ACTOR)
  const draftId = acceptedThird.ok ? acceptedThird.documentId : 0

  ok('a reason is required', !(await cancelOrder(SITE, third.orderId, '   ')).ok)
  const cancelled = await cancelOrder(SITE, third.orderId, 'Out of stock')
  ok('cancelling with a reason works', cancelled.ok, cancelled.ok ? '' : cancelled.error)

  const draftGone = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE id = ?`,
    [draftId],
  )
  ok('the draft sale is discarded with it', Number(draftGone?.n) === 0)

  const afterCancel = await getOrder(SITE, third.orderId)
  ok('the order reads as cancelled', afterCancel?.statusRole === 'cancelled')
  ok('the reason is kept', afterCancel?.declineReason === 'Out of stock')
  ok('the sale is unlinked', afterCancel?.documentId === null)
  ok('cancelling twice is refused', !(await cancelOrder(SITE, third.orderId, 'again')).ok)

  console.log('\n— Archiving is housekeeping, not a status —')
  ok(
    'an order still in progress cannot be archived',
    !(await archiveOrder(SITE, orderId, true)).ok,
  )
  ok('a cancelled order can be', (await archiveOrder(SITE, third.orderId, true)).ok)

  const queue = await listOrders(SITE)
  const archive = await listOrders(SITE, { archived: true })
  ok(
    'the queue hides archived orders',
    !queue.some((o) => o.id === third.orderId),
  )
  ok(
    'the archive shows them',
    archive.some((o) => o.id === third.orderId),
  )
  ok('restoring puts it back', (await archiveOrder(SITE, third.orderId, false)).ok)

  const counts = await orderCounts(SITE)
  ok('status counts are reported', counts.size > 0)

  console.log('\n— Cleanup —')
  const removed = await cleanup()
  ok('every test order removed', removed > 0)
  const leftover = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE reference LIKE ?`,
    [`${TAG}%`],
  )
  ok('no draft sales left behind', Number(leftover?.n) === 0, `${leftover?.n}`)

  console.log(`\n${fails === 0 ? 'All online order checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await cleanup().catch(() => {})
  process.exit(1)
})

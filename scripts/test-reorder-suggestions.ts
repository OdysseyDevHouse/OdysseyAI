/**
 * Suggested ordering — what to buy, and why.
 *
 * THE RULE THAT MATTERS MOST: every basis subtracts what is ALREADY ON ORDER.
 * Without it, running the suggestion twice orders everything twice — the first
 * order has not arrived, so stock is still low, so the second run proposes it
 * all again. That is how an auto-replenishment feature loses a shop's trust in
 * a week, and it is checked on every basis below rather than once.
 *
 * A suggestion writes nothing. That is checked too: the whole point is that a
 * buyer reviews and corrects before anything becomes an order.
 *
 *   npm run test:reorder-suggestions
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { reorderSuggestions, reorderBySupplier } from '../src/lib/site/reorderSuggestions'
import { saveOrder, issueOrder } from '../src/lib/site/purchaseDocuments'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Reorder Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const mainLoc = await siteQueryOne<any>(
    SITE,
    'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1',
  )
  const locationId = Number(mainLoc!.id)

  const sup = await createSupplier(SITE, actor, {
    code: `RO${stamp}`,
    name: 'Reorder Test Supply',
    paymentTermsDays: 30,
    leadTimeDays: 7,
    minimumOrder: 500,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  /** A product with a known position and levels in the main location. */
  const mk = async (
    suffix: string,
    opts: { onHand: number; min: number; max: number; cost?: number; pack?: number; type?: string },
  ) => {
    const id = (
      await siteExecute(
        SITE,
        `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
         VALUES (?,?,?,?,?,?,1)`,
        [
          `RO${suffix}${stamp}`,
          `Reorder ${suffix} ${stamp}`,
          opts.type ?? 'normal',
          opts.onHand,
          opts.cost ?? 10,
          opts.cost ?? 10,
        ],
      )
    ).insertId

    await siteExecute(
      SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand), min_stock=VALUES(min_stock), max_stock=VALUES(max_stock)`,
      [id, locationId, opts.onHand, opts.min, opts.max],
    )
    await siteExecute(
      SITE,
      `INSERT INTO product_suppliers (product_id, supplier_id, supplier_code, last_cost, pack_size, is_preferred)
       VALUES (?,?,?,?,?,1)`,
      [id, sup.id, `THEIR-${suffix}`, opts.cost ?? 10, opts.pack ?? 1],
    )
    return id
  }

  console.log('\n── Below minimum ──')

  // 3 on hand, floor of 10, ceiling of 50. Should propose topping up to 50.
  const low = await mk('LOW', { onHand: 3, min: 10, max: 50 })
  // 30 on hand, comfortably above its floor of 10. Should not appear.
  const fine = await mk('FINE', { onHand: 30, min: 10, max: 50 })

  let out = await reorderSuggestions(SITE, { locationId, basis: 'below_minimum', supplierId: sup.id })
  const lowRow = out.find((s) => s.productId === low)
  ok('*** a product under its minimum is proposed ***', !!lowRow)
  ok(
    '*** topped up to MAX, not to min: 50 - 3 = 47 ***',
    lowRow?.suggested === 47,
    String(lowRow?.suggested),
  )
  ok('  and it carries its reasoning', lowRow?.stockOnHand === 3 && lowRow?.minStock === 10)
  ok('*** a product above its minimum is NOT proposed ***', !out.some((s) => s.productId === fine))

  ok(
    'the preferred supplier comes through',
    lowRow?.supplierId === sup.id && lowRow?.supplierName === 'Reorder Test Supply',
  )
  ok('  with their own code', lowRow?.supplierCode === 'THEIR-LOW', String(lowRow?.supplierCode))
  ok('  and their lead time', lowRow?.leadTimeDays === 7, String(lowRow?.leadTimeDays))

  console.log('\n── THE SUBTRACTION: what is already on order ──')

  // Raise and issue an order for 30 of the low product. The suggestion must
  // now propose only the remaining 17.
  const order = await saveOrder(SITE, actor, {
    supplierId: sup.id,
    lines: [
      { productId: low, description: 'Reorder LOW', qtyOrdered: 30, unitCostExcl: 10, vatRatePct: 15 },
    ],
  })
  ok('an order saves', order.ok)
  if (!order.ok) process.exit(1)

  out = await reorderSuggestions(SITE, { locationId, basis: 'below_minimum', supplierId: sup.id })
  ok(
    'a DRAFT order does not count — it has not been sent',
    out.find((s) => s.productId === low)?.suggested === 47,
    String(out.find((s) => s.productId === low)?.suggested),
  )

  await issueOrder(SITE, order.id)

  // includeSufficient, because the point of the subtraction is that this
  // product should now be proposing NOTHING — and a row proposing nothing is
  // filtered out of the normal list. Asking for it explicitly is how the
  // figures behind that zero can be checked.
  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'below_minimum',
    supplierId: sup.id,
    includeSufficient: true,
  })
  const afterOrder = out.find((s) => s.productId === low)
  ok('*** an ISSUED order counts ***', afterOrder?.onOrder === 30, String(afterOrder?.onOrder))
  ok(
    '*** 3 on hand + 30 coming clears the floor, so nothing more is proposed ***',
    afterOrder?.suggested === 0,
    `${afterOrder?.suggested} (a bug here would say 47 and double-order)`,
  )

  // And the same subtraction under min_to_max, where the product IS still
  // below its ceiling — this is where the arithmetic shows rather than
  // collapsing to zero. 50 target, less 3 on hand, less 30 coming = 17.
  out = await reorderSuggestions(SITE, { locationId, basis: 'min_to_max', supplierId: sup.id })
  const topUp = out.find((s) => s.productId === low)
  ok(
    '*** min_to_max proposes only the remaining 17, not 47 again ***',
    topUp?.suggested === 17,
    `${topUp?.suggested} (a bug here would say 47 and double-order)`,
  )

  // And once it arrives, the on-order figure must fall away rather than
  // double-counting against the stock it became.
  const orderDoc = await siteQuery<any>(
    SITE,
    'SELECT id FROM purchase_document_lines WHERE document_id = ?',
    [order.id],
  )
  await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    orderId: order.id,
    lines: [
      {
        orderLineId: Number(orderDoc[0].id),
        productId: low,
        description: 'Reorder LOW',
        qtyOrdered: 30,
        qtyReceived: 30,
        unitCostExcl: 10,
        vatRatePct: 15,
      },
    ],
  })

  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'below_minimum',
    supplierId: sup.id,
    includeSufficient: true,
  })
  const afterReceipt = out.find((s) => s.productId === low)
  ok('*** once received, nothing is on order ***', afterReceipt?.onOrder === 0, String(afterReceipt?.onOrder))
  ok(
    '  33 on hand is above the floor of 10, so nothing more is proposed',
    afterReceipt?.suggested === 0,
    `on hand ${afterReceipt?.stockOnHand}, suggested ${afterReceipt?.suggested}`,
  )

  console.log('\n── Min to max ──')

  // 30 on hand against a ceiling of 50: below_minimum ignores it, min_to_max
  // tops it up.
  out = await reorderSuggestions(SITE, { locationId, basis: 'min_to_max', supplierId: sup.id })
  const fineTopUp = out.find((s) => s.productId === fine)
  ok(
    '*** a product above its minimum but below max IS topped up ***',
    fineTopUp?.suggested === 20,
    String(fineTopUp?.suggested),
  )

  console.log('\n── Pack sizes ──')

  // 0 on hand, ceiling of 10, shipped in cases of 6. 10 rounds up to 12.
  const packed = await mk('PACK', { onHand: 0, min: 5, max: 10, pack: 6 })
  out = await reorderSuggestions(SITE, { locationId, basis: 'below_minimum', supplierId: sup.id })
  const packRow = out.find((s) => s.productId === packed)
  ok(
    '*** 10 needed in cases of 6 rounds UP to 12 ***',
    packRow?.suggested === 12,
    String(packRow?.suggested),
  )
  ok('  the raw figure is kept for the buyer to see', packRow?.rawSuggested === 10)

  console.log('\n── Velocity ──')

  // A product that has sold 60 units in the last 30 days: 2/day. With a 7-day
  // lead time and 14 days of cover, the target is 42.
  const fast = await mk('FAST', { onHand: 10, min: 0, max: 0 })
  await siteExecute(
    SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_name, created_at)
     VALUES (?,?,'sale',-60,0,10,'sale','Reorder Test', DATE_SUB(NOW(), INTERVAL 5 DAY))`,
    [fast, locationId],
  )

  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'velocity',
    supplierId: sup.id,
    windowDays: 30,
    coverDays: 14,
  })
  const fastRow = out.find((s) => s.productId === fast)
  ok('*** a fast mover is proposed ***', !!fastRow)
  ok('  60 sold over the window', fastRow?.soldInWindow === 60, String(fastRow?.soldInWindow))
  ok('  which is 2 a day', fastRow?.dailyDemand === 2, String(fastRow?.dailyDemand))
  ok(
    '*** target = 2/day x (7 lead + 14 cover) = 42 ***',
    fastRow?.target === 42,
    String(fastRow?.target),
  )
  ok(
    '*** less the 10 on hand = 32 ***',
    fastRow?.suggested === 32,
    String(fastRow?.suggested),
  )

  // A return reduces demand — a unit sold and brought back was not really sold.
  await siteExecute(
    SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_name, created_at)
     VALUES (?,?,'sale_return',10,0,10,'sale_return','Reorder Test', DATE_SUB(NOW(), INTERVAL 4 DAY))`,
    [fast, locationId],
  )
  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'velocity',
    supplierId: sup.id,
    windowDays: 30,
    coverDays: 14,
  })
  ok(
    '*** returns net off demand: 60 sold less 10 back = 50 ***',
    out.find((s) => s.productId === fast)?.soldInWindow === 50,
    String(out.find((s) => s.productId === fast)?.soldInWindow),
  )

  // A sale older than the window must not count.
  const stale = await mk('STALE', { onHand: 0, min: 0, max: 0 })
  await siteExecute(
    SITE,
    `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after, unit_cost_excl, source, user_name, created_at)
     VALUES (?,?,'sale',-100,0,10,'sale','Reorder Test', DATE_SUB(NOW(), INTERVAL 200 DAY))`,
    [stale, locationId],
  )
  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'velocity',
    supplierId: sup.id,
    windowDays: 30,
    includeSufficient: true,
  })
  ok(
    '*** a sale outside the window is not demand ***',
    out.find((s) => s.productId === stale)?.soldInWindow === 0,
    String(out.find((s) => s.productId === stale)?.soldInWindow),
  )

  console.log('\n── What is left out ──')

  const service = await mk('SVC', { onHand: 0, min: 10, max: 50, type: 'service' })
  out = await reorderSuggestions(SITE, { locationId, basis: 'min_to_max', supplierId: sup.id })
  ok(
    '*** a service is never proposed — it has no stock to run out of ***',
    !out.some((s) => s.productId === service),
  )

  const archived = await mk('ARCH', { onHand: 0, min: 10, max: 50 })
  await siteExecute(SITE, 'UPDATE products SET is_archived = 1 WHERE id = ?', [archived])
  out = await reorderSuggestions(SITE, { locationId, basis: 'min_to_max', supplierId: sup.id })
  ok('*** an archived product is not proposed ***', !out.some((s) => s.productId === archived))

  console.log('\n── Grouped by supplier ──')

  const groups = await reorderBySupplier(SITE, {
    locationId,
    basis: 'min_to_max',
    supplierId: sup.id,
  })
  const mine = groups.find((g) => g.supplierId === sup.id)
  ok('*** the suggestions group under their supplier ***', !!mine)
  ok('  carrying their minimum order', mine?.minimumOrder === 500, String(mine?.minimumOrder))
  ok('  and a total to compare it against', (mine?.totalExcl ?? 0) > 0, String(mine?.totalExcl))
  ok(
    '  the total is the sum of its lines',
    Math.abs(
      (mine?.totalExcl ?? 0) -
        (mine?.lines ?? []).reduce((s, l) => s + l.suggested * l.unitCostExcl, 0),
    ) < 0.02,
  )

  console.log('\n── A suggestion writes nothing ──')

  const before = await siteQueryOne<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM purchase_documents WHERE doc_type='purchase_order'",
  )
  await reorderSuggestions(SITE, { locationId, basis: 'velocity', supplierId: sup.id })
  await reorderBySupplier(SITE, { locationId, basis: 'min_to_max', supplierId: sup.id })
  const after = await siteQueryOne<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM purchase_documents WHERE doc_type='purchase_order'",
  )
  ok(
    '*** running a suggestion created NO orders ***',
    Number(before.n) === Number(after.n),
    `${before.n} -> ${after.n}`,
  )

  const stockUnchanged = await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand FROM product_location_stock WHERE product_id=? AND location_id=?',
    [fast, locationId],
  )
  ok('  and moved no stock', toNum(stockUnchanged.stock_on_hand) === 10, String(stockUnchanged.stock_on_hand))

  console.log('\n── Edge cases ──')

  const noLevels = await mk('NONE', { onHand: 0, min: 0, max: 0 })
  out = await reorderSuggestions(SITE, { locationId, basis: 'below_minimum', supplierId: sup.id })
  ok(
    'a product with no levels set is not proposed by below_minimum',
    !out.some((s) => s.productId === noLevels),
  )

  out = await reorderSuggestions(SITE, {
    locationId,
    basis: 'velocity',
    supplierId: sup.id,
    windowDays: 30,
  })
  ok(
    'nor by velocity when it has never sold',
    !out.some((s) => s.productId === noLevels),
  )

  const negative = await mk('NEG', { onHand: -5, min: 10, max: 50 })
  out = await reorderSuggestions(SITE, { locationId, basis: 'below_minimum', supplierId: sup.id })
  ok(
    '*** negative stock proposes enough to get back to max: 50 + 5 ***',
    out.find((s) => s.productId === negative)?.suggested === 55,
    String(out.find((s) => s.productId === negative)?.suggested),
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

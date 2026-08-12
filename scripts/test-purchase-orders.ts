/**
 * Purchase orders — the front half of purchasing.
 *
 * An ORDER MOVES NOTHING: no stock, no cost, no ledger. That is the property
 * most of this script checks, because it is the one that would be silent if it
 * broke — an order that quietly moved stock would show up as a stock-take
 * discrepancy weeks later with nothing pointing back here.
 *
 * The other half is the handover to receiving: an order that has been received
 * against must close its lines, move its fulfilment status, and refuse to be
 * cancelled afterwards.
 *
 *   npm run test:purchase-orders
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  saveOrder,
  issueOrder,
  cancelOrder,
  getPurchaseDocument,
  openOrders,
  validateOrder,
  productPositions,
} from '../src/lib/site/purchaseDocuments'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { listLocations, createLocation, mainLocationId } from '../src/lib/site/stockLocations'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { verifySequence } from '../src/lib/site/sequences'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Order Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  console.log('\n── Validation, before anything touches the database ──')

  ok('an order with no lines is refused', validateOrder({ supplierId: 1, lines: [] }) !== null)
  ok(
    'a line with no description is refused',
    validateOrder({
      supplierId: 1,
      lines: [{ description: '  ', qtyOrdered: 1, unitCostExcl: 1, vatRatePct: 15 }],
    }) !== null,
  )
  ok(
    'a zero quantity is refused',
    validateOrder({
      supplierId: 1,
      lines: [{ description: 'x', qtyOrdered: 0, unitCostExcl: 1, vatRatePct: 15 }],
    }) !== null,
  )
  ok(
    'a negative cost is refused',
    validateOrder({
      supplierId: 1,
      lines: [{ description: 'x', qtyOrdered: 1, unitCostExcl: -1, vatRatePct: 15 }],
    }) !== null,
  )
  ok(
    'a sound order passes',
    validateOrder({
      supplierId: 1,
      lines: [{ description: 'x', qtyOrdered: 1, unitCostExcl: 1, vatRatePct: 15 }],
    }) === null,
  )

  // ── Fixtures
  const stamp = Date.now().toString().slice(-8)
  const vat =
    (await siteQueryOne<any>(
      SITE,
      "SELECT id, rate FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1",
    )) ??
    (await siteQueryOne<any>(
      SITE,
      "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
    ))
  const rate = toNum(vat?.rate, 15)

  const sup = await createSupplier(SITE, actor, {
    code: `ORD${stamp}`,
    name: 'Order Test Suppliers',
    paymentTermsDays: 30,
    leadTimeDays: 7,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const seqBefore = await verifySequence(SITE, 'purchase_order')

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`OP${stamp}`, `Order test item ${stamp}`],
  )
  const productId = p.insertId

  console.log('\n── Saving a draft ──')

  const draft = await saveOrder(SITE, actor, {
    supplierId: sup.id,
    expectedDate: '2026-09-01',
    supplierOrderNo: `THEIRS-${stamp}`,
    reference: 'Test order',
    lines: [
      {
        productId,
        productCode: `OP${stamp}`,
        supplierCode: 'THEIR-CODE',
        description: 'Order test item',
        qtyOrdered: 100,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('*** a draft order saves ***', draft.ok, draft.ok ? String(draft.id) : draft.error)
  if (!draft.ok) process.exit(1)

  let doc = await getPurchaseDocument(SITE, draft.id)
  ok('  it is a purchase_order', doc?.docType === 'purchase_order')
  ok('  status is draft', doc?.status === 'draft', doc?.status)
  ok(
    '*** a DRAFT has NO number — it must not consume one ***',
    doc?.documentNumber === null,
    String(doc?.documentNumber),
  )
  ok('  the expected date was kept', doc?.expectedDate === '2026-09-01', String(doc?.expectedDate))
  ok(
    '  their order number was kept',
    doc?.supplierOrderNo === `THEIRS-${stamp}`,
    String(doc?.supplierOrderNo),
  )
  ok('  the line is there', doc?.lines.length === 1)
  ok('  qty_ordered is what was asked for', toNum(doc?.lines[0]?.qtyOrdered) === 100)
  ok('  nothing has been received yet', toNum(doc?.lines[0]?.qtyReceived) === 0)
  ok('  totals exclude VAT', toNum(doc?.subtotalExcl) === 1000, String(doc?.subtotalExcl))

  // THE property of an order.
  let state = await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand, average_cost FROM products WHERE id=?',
    [productId],
  )
  ok(
    '*** SAVING AN ORDER MOVED NO STOCK ***',
    toNum(state.stock_on_hand) === 0,
    String(state.stock_on_hand),
  )
  ok(
    '*** and did NOT touch average cost ***',
    toNum(state.average_cost) === 0,
    String(state.average_cost),
  )

  console.log('\n── Editing the draft ──')

  const edited = await saveOrder(
    SITE,
    actor,
    {
      supplierId: sup.id,
      expectedDate: '2026-09-15',
      lines: [
        {
          productId,
          description: 'Order test item',
          qtyOrdered: 60,
          unitCostExcl: 12,
          vatRatePct: rate,
        },
        {
          description: 'A second line, no product',
          qtyOrdered: 5,
          unitCostExcl: 100,
          vatRatePct: rate,
        },
      ],
    },
    draft.id,
  )
  ok('a draft can be edited', edited.ok, edited.ok ? '' : edited.error)

  doc = await getPurchaseDocument(SITE, draft.id)
  ok('  lines are rewritten wholesale', doc?.lines.length === 2, String(doc?.lines.length))
  ok('  the new quantity took', toNum(doc?.lines[0]?.qtyOrdered) === 60)
  ok('  totals recomputed', toNum(doc?.subtotalExcl) === 1220, String(doc?.subtotalExcl))
  ok('  it is still a draft with no number', doc?.status === 'draft' && doc?.documentNumber === null)

  console.log('\n── A line discount ──')

  const discounted = await saveOrder(
    SITE,
    actor,
    {
      supplierId: sup.id,
      lines: [
        {
          productId,
          description: 'Order test item',
          qtyOrdered: 10,
          unitCostExcl: 100,
          discountPct: 10,
          vatRatePct: rate,
        },
      ],
    },
    draft.id,
  )
  ok('a percentage discount saves', discounted.ok)
  doc = await getPurchaseDocument(SITE, draft.id)
  ok('  1000 less 10% = 900', toNum(doc?.subtotalExcl) === 900, String(doc?.subtotalExcl))

  // The absolute amount wins — the reason 086 exists. Skipped where that
  // migration has not reached this site yet, rather than failing for a
  // schema difference the code deliberately tolerates.
  const hasAmount = await siteQueryOne<any>(
    SITE,
    `SELECT 1 AS present FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_lines'
        AND COLUMN_NAME = 'discount_amount' LIMIT 1`,
  )
  if (hasAmount?.present) {
    const byAmount = await saveOrder(
      SITE,
      actor,
      {
        supplierId: sup.id,
        lines: [
          {
            productId,
            description: 'Order test item',
            qtyOrdered: 10,
            unitCostExcl: 100,
            discountPct: 10,
            discountAmount: 250,
            vatRatePct: rate,
          },
        ],
      },
      draft.id,
    )
    ok('an absolute discount saves', byAmount.ok)
    doc = await getPurchaseDocument(SITE, draft.id)
    ok(
      '*** the AMOUNT beats the percentage (1000 - 250, not - 100) ***',
      toNum(doc?.subtotalExcl) === 750,
      String(doc?.subtotalExcl),
    )
    ok('  and is read back', toNum(doc?.lines[0]?.discountAmount) === 250)
  } else {
    console.log('SKIP  discount_amount — migration 086 has not reached this site')
  }

  console.log('\n── A destination per line ──')

  /*
   * An order can say where each line is HEADED. This does not make it move
   * anything — that is asserted below, and it is the property that would be
   * silent if it broke — it records the buyer's intent so receiving can inherit
   * it instead of the receiver rebuilding the split from a delivery note.
   */
  const mainId = await mainLocationId(SITE)
  const existingSpare = (await listLocations(SITE, false, true)).find((l) => l.id !== mainId)
  const spareLocation =
    existingSpare ??
    (await (async () => {
      const made = await createLocation(SITE, { code: `OL${stamp}`, name: 'Order test store' })
      if (!made.ok) return null
      return (await listLocations(SITE, false, true)).find((l) => l.id === made.id) ?? null
    })())

  if (!spareLocation) {
    console.log('SKIP  per-line destination — could not obtain a second location')
  } else {
    const split = await saveOrder(
      SITE,
      actor,
      {
        supplierId: sup.id,
        lines: [
          {
            productId,
            description: 'For the warehouse',
            locationId: spareLocation.id,
            qtyOrdered: 10,
            unitCostExcl: 10,
            vatRatePct: rate,
          },
          {
            productId,
            description: 'For the shop',
            locationId: mainId,
            qtyOrdered: 2,
            unitCostExcl: 10,
            vatRatePct: rate,
          },
          {
            productId,
            description: 'Wherever main is when it lands',
            qtyOrdered: 1,
            unitCostExcl: 10,
            vatRatePct: rate,
          },
        ],
      },
      draft.id,
    )
    ok('an order with a destination per line saves', split.ok, split.ok ? '' : split.error)

    doc = await getPurchaseDocument(SITE, draft.id)
    ok(
      '*** each line kept its OWN destination ***',
      doc?.lines[0]?.locationId === spareLocation.id && doc?.lines[1]?.locationId === mainId,
      `${doc?.lines[0]?.locationId} / ${doc?.lines[1]?.locationId}`,
    )
    ok(
      '  a line that named none stays null — resolved at receipt, not pinned here',
      doc?.lines[2]?.locationId === null,
      String(doc?.lines[2]?.locationId),
    )

    // A stale dropdown must not fail the save on a foreign key. Nothing has
    // moved, so falling back to "wherever main is then" is the honest answer.
    const bogus = await saveOrder(
      SITE,
      actor,
      {
        supplierId: sup.id,
        lines: [
          {
            productId,
            description: 'Headed nowhere real',
            locationId: 999999999,
            qtyOrdered: 1,
            unitCostExcl: 10,
            vatRatePct: rate,
          },
        ],
      },
      draft.id,
    )
    ok('a location that does not exist does not break the save', bogus.ok, bogus.ok ? '' : bogus.error)
    doc = await getPurchaseDocument(SITE, draft.id)
    ok('  it was written as null instead', doc?.lines[0]?.locationId === null)

    state = await siteQueryOne<any>(
      SITE,
      'SELECT stock_on_hand, average_cost FROM products WHERE id=?',
      [productId],
    )
    ok(
      '*** NAMING A DESTINATION STILL MOVED NO STOCK ***',
      toNum(state.stock_on_hand) === 0,
      String(state.stock_on_hand),
    )
    ok(
      '*** and still did not touch average cost ***',
      toNum(state.average_cost) === 0,
      String(state.average_cost),
    )
  }

  console.log('\n── Issuing ──')

  // Back to something simple to receive against.
  await saveOrder(
    SITE,
    actor,
    {
      supplierId: sup.id,
      lines: [
        {
          productId,
          productCode: `OP${stamp}`,
          description: 'Order test item',
          qtyOrdered: 100,
          unitCostExcl: 10,
          vatRatePct: rate,
        },
      ],
    },
    draft.id,
  )

  const issued = await issueOrder(SITE, draft.id)
  ok('*** an order issues ***', issued.ok, issued.ok ? '' : issued.error)

  doc = await getPurchaseDocument(SITE, draft.id)
  ok('  status is issued', doc?.status === 'issued', doc?.status)
  ok(
    '*** THE NUMBER IS CLAIMED AT ISSUE, not at draft ***',
    (doc?.documentNumber ?? '').startsWith('PO'),
    String(doc?.documentNumber),
  )

  ok('issuing twice is refused', !(await issueOrder(SITE, draft.id)).ok)

  const open = await openOrders(SITE, sup.id)
  ok(
    '*** an issued order appears as open, so receiving can find it ***',
    open.some((o) => o.id === draft.id),
    `${open.length} open`,
  )

  state = await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id=?', [productId])
  ok('*** ISSUING MOVED NO STOCK EITHER ***', toNum(state.stock_on_hand) === 0)

  console.log('\n── Receiving against it ──')

  const orderDoc = await getPurchaseDocument(SITE, draft.id)
  const orderLineId = orderDoc!.lines[0].id

  const part = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    orderId: draft.id,
    supplierInvoiceNo: `INV-${stamp}`,
    lines: [
      {
        orderLineId,
        productId,
        description: 'Order test item',
        qtyOrdered: 100,
        qtyReceived: 40,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('a partial receipt posts', part.ok, part.ok ? part.documentNumber : part.error)

  doc = await getPurchaseDocument(SITE, draft.id)
  ok(
    '*** the ORDER LINE records what arrived ***',
    toNum(doc?.lines[0]?.qtyReceived) === 40,
    String(doc?.lines[0]?.qtyReceived),
  )
  ok('  60 still outstanding', toNum(doc?.lines[0]?.qtyOutstanding) === 60)
  ok(
    '*** fulfilment moved to part_received ***',
    doc?.fulfilmentStatus === 'part_received',
    String(doc?.fulfilmentStatus),
  )
  ok(
    '  a part-received order is still open for receiving',
    (await openOrders(SITE, sup.id)).some((o) => o.id === draft.id),
  )
  ok(
    '  a part-received order CANNOT be cancelled',
    !(await cancelOrder(SITE, draft.id, 'changed my mind')).ok,
  )

  const rest = await receiveGoods(SITE, actor, {
    supplierId: sup.id,
    orderId: draft.id,
    lines: [
      {
        orderLineId,
        productId,
        description: 'Order test item',
        qtyOrdered: 100,
        qtyReceived: 60,
        unitCostExcl: 10,
        vatRatePct: rate,
      },
    ],
  })
  ok('the balance receives', rest.ok, rest.ok ? '' : rest.error)

  doc = await getPurchaseDocument(SITE, draft.id)
  ok('*** fulfilment moved to received ***', doc?.fulfilmentStatus === 'received', String(doc?.fulfilmentStatus))
  ok('  nothing outstanding', toNum(doc?.lines[0]?.qtyOutstanding) === 0)
  ok(
    '*** a fully received order drops off the open list ***',
    !(await openOrders(SITE, sup.id)).some((o) => o.id === draft.id),
  )

  state = await siteQueryOne<any>(
    SITE,
    'SELECT stock_on_hand, average_cost FROM products WHERE id=?',
    [productId],
  )
  ok('  stock arrived across both receipts', toNum(state.stock_on_hand) === 100, String(state.stock_on_hand))
  ok('  and NOW average cost has moved', toNum(state.average_cost) === 10, String(state.average_cost))

  console.log('\n── Cancelling ──')

  const spare = await saveOrder(SITE, actor, {
    supplierId: sup.id,
    lines: [{ productId, description: 'Order test item', qtyOrdered: 5, unitCostExcl: 10, vatRatePct: rate }],
  })
  ok('a second draft saves', spare.ok)
  if (spare.ok) {
    ok('a reason is required in spirit — an empty one still cancels with a default',
      (await cancelOrder(SITE, spare.id, '')).ok)
    const cancelled = await getPurchaseDocument(SITE, spare.id)
    ok('  status is cancelled', cancelled?.status === 'cancelled')
    ok(
      '  and it never took a number',
      cancelled?.documentNumber === null,
      String(cancelled?.documentNumber),
    )
    ok(
      '  a cancelled order is not offered for receiving',
      !(await openOrders(SITE, sup.id)).some((o) => o.id === spare.id),
    )
    ok('  editing a cancelled order is refused',
      !(await saveOrder(SITE, actor, {
        supplierId: sup.id,
        lines: [{ description: 'x', qtyOrdered: 1, unitCostExcl: 1, vatRatePct: rate }],
      }, spare.id)).ok)
  }

  console.log('\n── Refusals ──')

  ok(
    'an unknown supplier is refused',
    !(await saveOrder(SITE, actor, {
      supplierId: 999999999,
      lines: [{ description: 'x', qtyOrdered: 1, unitCostExcl: 1, vatRatePct: rate }],
    })).ok,
  )
  ok('issuing an order that does not exist is refused', !(await issueOrder(SITE, 999999999)).ok)
  ok(
    'editing an order that does not exist is refused',
    !(await saveOrder(SITE, actor, {
      supplierId: sup.id,
      lines: [{ description: 'x', qtyOrdered: 1, unitCostExcl: 1, vatRatePct: rate }],
    }, 999999999)).ok,
  )

  console.log('\n── Product positions, which the grid prices against ──')

  const positions = await productPositions(SITE, [productId])
  ok('a position comes back for a real product', positions.length === 1)
  ok('  it carries the stock figure', toNum(positions[0]?.stockOnHand) === 100)
  ok('  and the average cost', toNum(positions[0]?.averageCost) === 10)
  ok('an empty list asks nothing of the database', (await productPositions(SITE, [])).length === 0)
  ok('an unknown id simply returns nothing', (await productPositions(SITE, [999999999])).length === 0)

  console.log('\n── Invariants ──')

  // Scoped to THIS run's product. reconcileStock sweeps the whole site, and
  // the shared database carries litter from other suites — a global assertion
  // here would fail for their reasons rather than ours. The site-wide check
  // lives in test-purchasing.ts, which is run solo for exactly that reason.
  const drift = (await reconcileStock(SITE)).filter((d) => d.productId === productId)
  ok(
    '*** zero stock drift on the product this run touched ***',
    drift.length === 0,
    JSON.stringify(drift),
  )

  // Measured as a DELTA against the baseline taken at the top of this run: the
  // shared database may already carry gaps from other suites, and asserting an
  // absolute zero here would fail for their reasons rather than ours.
  const seqAfter = await verifySequence(SITE, 'purchase_order')
  ok(
    '*** every PO number this run issued has a document ***',
    seqAfter.missing === seqBefore.missing,
    `before ${seqBefore.missing}, after ${seqAfter.missing}`,
  )

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

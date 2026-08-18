/**
 * Closing an order the supplier will never finish.
 *
 * ── WHAT BREAKS WITHOUT THIS ──────────────────────────────────────────────
 *
 * An issued order counts as incoming stock in two places, both keyed on
 * `fulfilment_status IN ('open','part_received')`: openOrders(), and the
 * `on_order` subquery behind the reorder suggestions. A supplier who short-
 * ships and never sends the rest therefore leaves an order permanently
 * claiming the balance is on its way — and the suggestion screen quietly buys
 * that much less, forever, with an empty shelf as the only symptom.
 *
 * So the assertions that matter here are not "the status changed". They are:
 * the order leaves openOrders, the on-order figure DROPS BY THE OUTSTANDING
 * AMOUNT, and nothing else moves — no stock, no ledger, no rewritten lines.
 *
 * The lines being left alone is load-bearing. qty_ordered stays at what was
 * asked for and qty_received at what came, because the gap between them is
 * the whole record of the short delivery; rewriting the order down to what
 * arrived would make every short delivery invisible to a supplier-performance
 * question later.
 *
 *   npm run test:close-short
 */
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  saveOrder,
  issueOrder,
  cancelOrder,
  closeOrderShort,
  getPurchaseDocument,
  openOrders,
} from '../src/lib/site/purchaseDocuments'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { defaultVat, listVatRates } from '../src/lib/site/lookups'
import { reconcileStock } from '../src/lib/site/stockMovements'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Close Short Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * What the reorder suggestions believe is coming for one product.
 *
 * Deliberately a copy of the `on_order` subquery in reorderSuggestions.ts
 * rather than a call into it: that function needs a location, a basis and a
 * whole product position, and the thing under test is ONE predicate. Calling
 * the real screen would pass for reasons that have nothing to do with this.
 */
async function onOrderFor(productId: number): Promise<number> {
  const row = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    `SELECT COALESCE(SUM(GREATEST(ol.qty_ordered - ol.qty_received, 0)), 0) AS n
       FROM purchase_document_lines ol
       JOIN purchase_documents od ON od.id = ol.document_id
       LEFT JOIN purchase_order_details oo ON oo.document_id = od.id
      WHERE ol.product_id = ?
        AND od.doc_type = 'purchase_order'
        AND od.status = 'issued'
        AND COALESCE(oo.fulfilment_status, 'open') IN ('open','part_received')`,
    [productId],
  )
  return toNum(row?.n)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const sup = await createSupplier(SITE, actor, {
    code: `CLS${stamp}`,
    name: 'Close Short Test Suppliers',
    paymentTermsDays: 30,
    leadTimeDays: 7,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`CS${stamp}`, `Close short item ${stamp}`],
  )
  const productId = p.insertId

  const rates = await listVatRates(SITE)
  // Purchase VAT, falling back to sales — the same pick the ordering and
  // receiving screens make, so the test prices a line the way the app does.
  const rate = (defaultVat(rates, 'purchase') ?? defaultVat(rates, 'sales'))?.rate ?? 15

  try {
    /* ── an order, issued, then short-shipped ───────────────────────────── */
    console.log('\n── Setting up a short delivery ──')

    const draft = await saveOrder(SITE, actor, {
      supplierId: sup.id,
      reference: `Close short ${stamp}`,
      lines: [
        { productId, description: 'Close short item', qtyOrdered: 10, unitCostExcl: 10, vatRatePct: rate },
      ],
    })
    if (!draft.ok) {
      console.log('setup failed:', draft.error)
      process.exit(1)
    }

    ok('the order issues', (await issueOrder(SITE, actor, draft.id)).ok)
    ok('all 10 count as on order', (await onOrderFor(productId)) === 10,
      String(await onOrderFor(productId)))

    const orderDoc = await getPurchaseDocument(SITE, draft.id)
    const orderLineId = orderDoc!.lines[0].id

    const part = await receiveGoods(SITE, actor, {
      supplierId: sup.id,
      orderId: draft.id,
      supplierInvoiceNo: `CSINV-${stamp}`,
      lines: [
        {
          orderLineId,
          productId,
          description: 'Close short item',
          qtyOrdered: 10,
          qtyReceived: 7,
          unitCostExcl: 10,
          vatRatePct: rate,
        },
      ],
    })
    ok('7 of 10 arrive', part.ok, part.ok ? part.documentNumber : part.error)

    let doc = await getPurchaseDocument(SITE, draft.id)
    ok('the order is part received', doc?.fulfilmentStatus === 'part_received',
      String(doc?.fulfilmentStatus))
    ok('*** 3 are still counted as coming ***', (await onOrderFor(productId)) === 3,
      String(await onOrderFor(productId)))
    ok('and it cannot be cancelled — goods arrived',
      !(await cancelOrder(SITE, actor, draft.id, 'nope')).ok)

    /* ── the guards ─────────────────────────────────────────────────────── */
    console.log('\n── What may be closed ──')

    const stockBefore = await siteQueryOne<RowDataPacket & { stock_on_hand: number }>(
      SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [productId],
    )

    ok('a document that does not exist is refused',
      !(await closeOrderShort(SITE, actor, 999999999, 'x')).ok)

    const grvId = part.ok ? part.documentId : 0
    const grvAttempt = await closeOrderShort(SITE, actor, grvId, 'x')
    ok('a GRV is not closed from here', !grvAttempt.ok,
      grvAttempt.ok ? 'allowed!' : grvAttempt.error)

    // A draft was never sent, so there is nothing outstanding to give up on.
    const draft2 = await saveOrder(SITE, actor, {
      supplierId: sup.id,
      lines: [
        { productId, description: 'Draft item', qtyOrdered: 5, unitCostExcl: 10, vatRatePct: rate },
      ],
    })
    const draftAttempt = await closeOrderShort(SITE, actor, (draft2 as { id: number }).id, 'x')
    ok('a draft is refused — that is a cancel', !draftAttempt.ok,
      draftAttempt.ok ? 'allowed!' : draftAttempt.error)

    /* ── closing it ─────────────────────────────────────────────────────── */
    console.log('\n── Closing it short ──')

    const closed = await closeOrderShort(SITE, actor, draft.id, 'Supplier discontinued the line')
    ok('the order closes', closed.ok, closed.ok ? '' : closed.error)
    ok('  and reports what was written off', closed.ok && closed.outstanding === 3,
      closed.ok ? String(closed.outstanding) : '')

    ok('*** THE 3 NO LONGER COUNT AS COMING ***', (await onOrderFor(productId)) === 0,
      String(await onOrderFor(productId)))
    ok('*** it leaves the open-orders list ***',
      !(await openOrders(SITE, sup.id)).some((o) => o.id === draft.id))

    doc = await getPurchaseDocument(SITE, draft.id)
    ok('its fulfilment reads as received', doc?.fulfilmentStatus === 'received',
      String(doc?.fulfilmentStatus))

    /* ── and nothing else moved ─────────────────────────────────────────── */
    console.log('\n── What must NOT have changed ──')

    ok('*** THE LINES ARE UNTOUCHED — still ordered 10 ***',
      toNum(doc?.lines[0]?.qtyOrdered) === 10, String(doc?.lines[0]?.qtyOrdered))
    ok('*** and still received 7 — the short delivery stays visible ***',
      toNum(doc?.lines[0]?.qtyReceived) === 7, String(doc?.lines[0]?.qtyReceived))
    ok('the document status is still issued, not cancelled',
      doc?.status === 'issued', String(doc?.status))

    const stockAfter = await siteQueryOne<RowDataPacket & { stock_on_hand: number }>(
      SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [productId],
    )
    ok('*** CLOSING MOVED NO STOCK ***',
      toNum(stockBefore?.stock_on_hand) === toNum(stockAfter?.stock_on_hand),
      `${toNum(stockBefore?.stock_on_hand)} -> ${toNum(stockAfter?.stock_on_hand)}`)

    /* ── it is not a thing you do twice ─────────────────────────────────── */
    const again = await closeOrderShort(SITE, actor, draft.id, 'again')
    ok('closing an already-closed order is refused', !again.ok,
      again.ok ? 'allowed!' : again.error)

    /* ── the trail ──────────────────────────────────────────────────────── */
    const audit = await siteQueryOne<RowDataPacket & { detail: string }>(
      SITE,
      `SELECT detail FROM purchase_document_audit
        WHERE document_id = ? AND action = 'closed_short' LIMIT 1`,
      [draft.id],
    ).catch(() => null)
    // Silent where 139 has not reached this site, exactly as recordOrderPrint is.
    if (audit) {
      ok('the trail says how much was written off', /3 outstanding/.test(audit.detail),
        audit.detail)
      ok('  and why', /discontinued/i.test(audit.detail), audit.detail)
    } else {
      console.log('SKIP  no purchase_document_audit table on this site')
    }

    console.log('\n── Invariants ──')
    const drift = (await reconcileStock(SITE)).filter((d) => d.productId === productId)
    ok('*** zero stock drift on the product this run touched ***',
      drift.length === 0, JSON.stringify(drift))
  } finally {
    /* Scrubbed even when an assertion above threw: a leaked row on a UNIQUE
       column kills an unrelated suite before its first assertion. */
    await siteExecute(
      SITE,
      `DELETE FROM purchase_document_audit WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [sup.ok ? sup.id : 0],
    ).catch(() => {})
    await siteExecute(
      SITE,
      `DELETE FROM purchase_order_details WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [sup.ok ? sup.id : 0],
    ).catch(() => {})
    await siteExecute(
      SITE,
      `DELETE FROM purchase_document_lines WHERE document_id IN
         (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
      [sup.ok ? sup.id : 0],
    ).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [
      sup.ok ? sup.id : 0,
    ]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
  }

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

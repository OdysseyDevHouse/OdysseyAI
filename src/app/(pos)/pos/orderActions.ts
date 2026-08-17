'use server'

import { actorFor, actorForOrThrow, withTillOperator } from '@/lib/auth'
import { listOrders, getOrder, deliverOrder, type FulfilmentStatus } from '@/lib/site/salesOrders'
import { getDocument } from '@/lib/site/salesDocuments'
import type { RecalledSale } from './actions'
import { basketLinesForDocument } from './recalledLines'

/**
 * Sales orders, at the till.
 *
 * ── COLLECTING AN ORDER IS A DELIVERY, NOT A RECALL ───────────────────────
 *
 * This is the whole difference between this file and quoteActions, and it is
 * worth stating plainly because the two screens look identical.
 *
 * A quote is a PRICE somebody was given. Recalling one puts its lines on the
 * till and the quote stays the document being written — nothing has moved and
 * nothing is owed until the customer says yes.
 *
 * An order is a PROMISE, and goods against it may already be reserved. When the
 * customer walks in to collect, the shop is not editing the order — it is
 * DELIVERING part or all of it, which raises a linked invoice for exactly what
 * goes out, decrements what is outstanding, and recomputes the fulfilment
 * status. An order half-collected last Tuesday must show three of five still
 * owed, and only a delivery records that.
 *
 * So this does not recall the order. It calls `deliverOrder` — the same
 * function the back office's delivery screen calls — and puts the DRAFT INVOICE
 * that comes back onto the till, where it is tendered like any other sale.
 *
 * Nothing about posting, numbering, stock movement or the credit limit is
 * reimplemented: the draft goes through the ordinary finalise path, because a
 * second posting engine is how two code paths start to disagree about what a
 * sale is.
 */

type Denied = { ok: false; error: string }

/** An order as the till's list shows it. */
export type TillOrder = {
  id: number
  documentNumber: string | null
  customerName: string | null
  totalIncl: number
  fulfilmentStatus: FulfilmentStatus
  /** What the customer called it — their own order number, if they gave one. */
  customerOrderNo: string | null
  deliveryDate: string | null
  /** Whether stock is being held against this order. */
  reservesStock: boolean
  qtyOutstanding: number
  /** Whether the till may collect against it — see below. */
  collectable: boolean
}

/**
 * Orders a counter could hand over.
 *
 * ── WHAT IS LISTED ────────────────────────────────────────────────────────
 *
 * OUTSTANDING ONLY — open and part-delivered. This is the one place the till's
 * list deliberately differs from the quote list, and the reason is that the two
 * questions differ.
 *
 * A cashier looking for a quote is looking for a PRICE, and a settled quote
 * still answers that: the customer holding a lapsed one needs to be told it
 * lapsed, which means finding it. An order that has been delivered in full has
 * nothing left to hand over, and showing it invites somebody to collect the
 * same goods twice — which the delivery path would then refuse, but only after
 * a cashier has told a customer they can have it.
 *
 * Cancelled orders are excluded by `listOrders` itself.
 *
 * ── AND WHY `collectable` IS STILL COMPUTED ───────────────────────────────
 *
 * The filter above is the list's decision; this is the ROW's. An order with
 * nothing outstanding can still appear here — the fulfilment status is derived
 * from the lines and a race between two tills can leave a row stale for a
 * moment — and a tappable row that then refuses is worse than one that says so.
 */
export async function listTillOrdersAction(search?: string): Promise<TillOrder[]> {
  const { siteId } = await actorForOrThrow('sales.till')

  const { items } = await listOrders(siteId, {
    fulfilment: 'outstanding',
    q: search,
    limit: 100,
  })

  return items.map((o) => ({
    id: o.id,
    documentNumber: o.documentNumber,
    customerName: o.customerName,
    totalIncl: o.totalIncl,
    fulfilmentStatus: o.fulfilmentStatus,
    customerOrderNo: o.customerOrderNo,
    deliveryDate: o.deliveryDate,
    reservesStock: o.reservesStock,
    qtyOutstanding: o.qtyOutstanding,
    /* `listOrders` already excludes cancelled documents, so what is left to
       judge is whether anything is actually still owed. */
    collectable: o.qtyOutstanding > 0 && o.fulfilmentStatus !== 'cancelled',
  }))
}

/**
 * Hands an order over at the counter, in full.
 *
 * ── WHY IN FULL, AND NOT LINE BY LINE ─────────────────────────────────────
 *
 * The back office delivers per line, because a warehouse dispatching part of an
 * order needs to say exactly which part. A counter is the other case: the
 * customer is standing there and either the goods are going with them or they
 * are not. Offering a quantity box per line would put a spreadsheet in front of
 * somebody holding a collection slip.
 *
 * A PARTIAL collection is still possible — deliver everything, then take the
 * lines the customer does not want off the basket before tendering. Those go
 * back as outstanding when the invoice is finalised for less. That is the
 * ordinary till gesture (remove a line) rather than a second delivery screen.
 *
 * ── WHAT COMES BACK ───────────────────────────────────────────────────────
 *
 * The DRAFT INVOICE, as basket lines. Not the order — the order stays an order
 * and its fulfilment status has already moved. The basket is an invoice from
 * here on, which is what lets the cashier tender it with no special handling at
 * all.
 */
export async function collectOrderForTillAction(
  orderId: number,
  priceStructureId: number | null,
  terminalId?: number | null,
  terminalCode?: string | null,
): Promise<RecalledSale | Denied> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const { siteId, actor } = await withTillOperator(base)

  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }

  if (order.document.status === 'cancelled') {
    return { ok: false, error: 'That order was cancelled.' }
  }
  if (order.details?.fulfilmentStatus === 'cancelled') {
    return { ok: false, error: 'That order was cancelled.' }
  }
  if (order.details?.fulfilmentStatus === 'delivered') {
    return {
      ok: false,
      error: 'That order has already been handed over in full.',
    }
  }

  /*
   * Everything still owed, which is what a counter collection IS. Lines already
   * delivered are skipped rather than refused — a part-delivered order is an
   * ordinary thing and the rest of it is exactly what the customer is here for.
   *
   * FILTERED, because `order.lines` is every line with its outstanding quantity
   * attached, not only the ones with something left. Passing a fully delivered
   * line through as qty 0 would have deliverOrder reject the whole call with
   * "Enter a quantity to deliver" the moment ANY line was already out.
   */
  const outstanding = order.lines.filter((l) => l.qtyOutstanding > 0)
  if (outstanding.length === 0) {
    return { ok: false, error: 'There is nothing outstanding on that order.' }
  }

  /*
   * THE DELIVERY. Same function the back office calls, with the same guards —
   * a cancelled order, an over-delivery, a line that is not on the order. It
   * writes the draft invoice, decrements the outstanding quantities and
   * recomputes the fulfilment status inside one transaction.
   *
   * The terminal is passed through so the invoice belongs to THIS till: without
   * it the delivery invoice would number from the shared sequence rather than
   * this machine's own run, which is the same trap the unclaimed-terminal
   * warning on the status bar exists to prevent.
   */
  const delivered = await deliverOrder(
    siteId,
    actor,
    orderId,
    outstanding.map((l) => ({ lineId: l.id, qty: l.qtyOutstanding })),
    { terminalId: terminalId ?? null, terminalCode: terminalCode ?? null },
  )
  if (!delivered.ok) return delivered

  const invoice = await getDocument(siteId, delivered.invoiceId)
  if (!invoice) {
    /* The delivery COMMITTED and the read failed — the goods are recorded as
       gone and there is an invoice waiting. Saying where it is beats a generic
       failure that invites the cashier to try again and deliver twice. */
    return {
      ok: false,
      error: `The order was delivered but its invoice could not be opened. Find draft #${delivered.invoiceId} in Invoicing.`,
    }
  }

  return {
    ok: true,
    documentId: invoice.id,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    /* Prices come from the ORDER's own snapshot — deliverOrder copies them —
       so a price rise between order and collection is the shop's problem, not
       the customer's. What basketLinesForDocument re-reads from the product is
       the EDITING rules: the discount ceiling, the shelf price to compare an
       override against, and whether a fraction is allowed. */
    lines: await basketLinesForDocument(siteId, invoice, priceStructureId),
  }
}

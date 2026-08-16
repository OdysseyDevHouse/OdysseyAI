'use server'

import { actorFor, actorForOrThrow, withTillOperator } from '@/lib/auth'
import { listOrders, acceptOrder, getOrder } from '@/lib/site/onlineOrders'
import { getDocument } from '@/lib/site/salesDocuments'
import type { RecalledSale } from './actions'
import { basketLinesForDocument } from './recalledLines'

/**
 * Collecting an online order at the counter.
 *
 * ── THE SHAPE OF THE THING ────────────────────────────────────────────────
 *
 * Somebody orders a burger and chips on the web shop and does NOT pay. They walk
 * in to fetch it. The cashier finds the order, it becomes the basket, the
 * customer adds a Coke from the fridge, and the whole lot is paid for and
 * finalised as one invoice. That is the flow this exists for, and every decision
 * below follows from it.
 *
 * ── WHY IT IS NOT A SEPARATE DOCUMENT ─────────────────────────────────────
 *
 * The Coke is the reason. An order invoiced on its own and a second sale for the
 * extras is two documents, two slips and two payments for one transaction at one
 * counter — and it makes "what did this customer actually spend" a question
 * requiring a join. Pulling the order into the basket means the extras land on
 * the same document, priced by the same engine, and the customer pays once.
 *
 * ── WHAT IS REUSED, AND WHY NOTHING IS REIMPLEMENTED ──────────────────────
 *
 * `acceptOrder` already does the hard half: it re-prices every line against
 * TODAY'S price file, drops products that have gone away, refuses an order whose
 * account credit no longer covers it, spreads the discount code, adds the
 * delivery line, releases the stock holds, and writes a draft sales document. It
 * is idempotent — an order that already has a document returns that document
 * rather than making a second — which is exactly what a till needs when a cashier
 * taps a tile twice.
 *
 * So this does not convert anything. It calls accept, then hands the resulting
 * document to the same line mapper a recalled sale uses.
 */

type Denied = { ok: false; error: string }

/** An order waiting to be collected, as the till's list shows it. */
export type CollectableOrder = {
  id: number
  orderNumber: string
  customerName: string
  contactPhone: string
  totalIncl: number
  lineCount: number
  fulfilment: 'collect' | 'deliver'
  statusName: string
  /** ISO. What the shopper asked for, when they asked for a time. */
  requestedFor: string | null
  placedAt: string
  /** Already paid online. Shown, and refused — see collectOnlineOrderAction. */
  paid: boolean
}

/**
 * Orders this counter could hand over.
 *
 * Deliberately NOT filtered down to "new" only. A shop that has already moved an
 * order to Preparing or Ready has done exactly what the pipeline is for, and a
 * list that then hid it would be a list that empties as the kitchen works. What
 * IS excluded is the archive and anything cancelled or completed: those are
 * finished, and offering one to a cashier invites handing over food twice.
 */
export async function listCollectableOrdersAction(): Promise<CollectableOrder[]> {
  const { siteId } = await actorForOrThrow('online.view')

  const orders = await listOrders(siteId, { limit: 100 })
  return orders
    .filter((order) => order.statusRole !== 'cancelled' && order.statusRole !== 'completed')
    .map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      /* The contact name, because an online order need not have an account behind
         it — a guest checkout is a phone number and a name and nothing else. */
      customerName: order.contactName.trim() || 'Online customer',
      contactPhone: order.contactPhone,
      totalIncl: order.totalIncl,
      lineCount: order.lineCount,
      fulfilment: order.fulfilment,
      statusName: order.statusName,
      requestedFor: order.requestedFor ? order.requestedFor.toISOString() : null,
      placedAt: order.placedAt.toISOString(),
      paid: order.paymentStatus === 'paid',
    }))
}

export type CollectedOrder = RecalledSale & { orderNumber?: string }

/**
 * Turns an online order into the basket on this till.
 *
 * ── THE PAID CHECK IS THE IMPORTANT ONE ───────────────────────────────────
 *
 * An order paid online has ALREADY been invoiced and finalised by
 * `invoicePaidOrder` — the money is taken and the document is closed. Pulling its
 * lines into a basket would ring the same goods up a second time and take the
 * money again, with nothing on either screen looking wrong. So it is refused
 * here, in the action, rather than only hidden in the list: the list is a screen
 * and this is the boundary.
 *
 * The other refusal is a document that is no longer a draft. `acceptOrder` writes
 * one and hands it back; if it comes back `finalised`, somebody has already put
 * this order through — probably at the other till, a minute ago. Saying so is
 * more use than a basket that fails at Pay.
 */
export async function collectOnlineOrderAction(
  orderId: number,
  priceStructureId: number | null,
): Promise<CollectedOrder | Denied> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const ctx = await withTillOperator(base)
  const { siteId, actor } = ctx

  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }

  if (order.paymentStatus === 'paid') {
    return {
      ok: false,
      error: `${order.orderNumber} was paid online and is already invoiced. Just hand it over.`,
    }
  }
  if (order.statusRole === 'cancelled') {
    return { ok: false, error: `${order.orderNumber} was cancelled.` }
  }

  /* Idempotent: an order already accepted returns its existing document rather
     than writing a second one, so a double tap is harmless. This is also where
     re-pricing against today's prices happens, and where an order whose products
     have gone away is refused. */
  const accepted = await acceptOrder(siteId, orderId, actor)
  if (!accepted.ok) return accepted

  const doc = await getDocument(siteId, accepted.documentId)
  if (!doc) return { ok: false, error: 'That order could not be turned into a sale.' }

  if (doc.status === 'finalised') {
    return {
      ok: false,
      error: `${order.orderNumber} has already been paid for and invoiced.`,
    }
  }
  if (doc.status === 'cancelled') {
    return { ok: false, error: `${order.orderNumber} was cancelled.` }
  }

  return {
    ok: true,
    documentId: doc.id,
    customerId: doc.customerId,
    /* The contact name when the order has no account — a guest checkout has a
       name and a phone number and nothing else, and a basket labelled "Walk-in"
       when the person is standing there holding an order number is unhelpful. */
    customerName: doc.customerName ?? order.contactName.trim() ?? null,
    lines: await basketLinesForDocument(siteId, doc, priceStructureId),
    orderNumber: order.orderNumber,
  }
}

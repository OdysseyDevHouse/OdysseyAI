'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor } from '@/lib/auth'
import {
  setOrderDetails,
  deliverOrder,
  cancelOrder,
  releaseStaleReservations,
  type DeliveryLineInput,
  type OrderDetailsInput,
} from '@/lib/site/salesOrders'
import { createBlankDocument } from '@/lib/site/salesDocuments'

/**
 * Order actions.
 *
 * Delivering hands back the id of the draft invoice it raised rather than
 * redirecting, so the screen can send the user straight to the till to take
 * payment — the delivery is only half the job.
 */

type ActionResult = { ok: true; message: string; invoiceId?: number } | { ok: false; error: string }

/**
 * Starts a blank sales order, for the capture screen to fill in.
 *
 * The same shape invoicing uses, and for the same reason: the editor needs a
 * document id to hang lines off, so the row exists before the screen opens.
 * `createBlankDocument` rather than `saveDraft` because that one rightly
 * refuses an empty document — see the quotes action, which spent its whole life
 * failing silently on exactly that.
 *
 * No order DETAILS are written here. A delivery date, a customer order number
 * and whether it reserves stock are all decisions somebody makes while
 * capturing, and `setOrderDetails` refuses an order with no lines anyway — so
 * they belong to the first save rather than to the moment the button is
 * pressed.
 */
export async function newOrderAction(): Promise<
  { ok: true; documentId: number } | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const draft = await createBlankDocument(siteId, actor, 'sales_order')
  if (!draft.ok) return { ok: false, error: draft.error }

  revalidatePath('/invoicing/orders')
  return { ok: true, documentId: draft.id }
}

export async function saveDetailsAction(
  documentId: number,
  input: OrderDetailsInput,
): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await setOrderDetails(siteId, documentId, input)
  if (!result.ok) return result

  revalidatePath(`/invoicing/orders/${documentId}`)
  revalidatePath('/invoicing/orders')
  return { ok: true, message: 'Delivery details saved.' }
}

export async function deliverAction(
  documentId: number,
  lines: DeliveryLineInput[],
): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deliverOrder(siteId, actor, documentId, lines)
  if (!result.ok) return result

  revalidatePath(`/invoicing/orders/${documentId}`)
  revalidatePath('/invoicing/orders')
  revalidatePath('/invoicing')

  return {
    ok: true,
    invoiceId: result.invoiceId,
    message:
      result.fulfilmentStatus === 'delivered'
        ? 'Delivered in full. Take payment on the invoice to finish.'
        : 'Delivery invoice raised. Take payment on it to finish.',
  }
}

export async function cancelOrderAction(documentId: number, reason: string): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await cancelOrder(siteId, actor, documentId, reason)
  if (!result.ok) return result

  revalidatePath(`/invoicing/orders/${documentId}`)
  revalidatePath('/invoicing/orders')
  return {
    ok: true,
    message:
      result.released > 0
        ? `Cancelled — ${result.released} released back to available stock.`
        : 'Order cancelled.',
  }
}

export async function releaseStaleAction(): Promise<ActionResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const released = await releaseStaleReservations(siteId, actor)
  revalidatePath('/invoicing/orders')

  return {
    ok: true,
    message:
      released.length === 0
        ? 'Nothing has expired — every reservation is still current.'
        : `${released.length} expired reservation${released.length === 1 ? '' : 's'} released.`,
  }
}

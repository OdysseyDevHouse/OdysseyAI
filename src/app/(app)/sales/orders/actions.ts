'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId } from '@/lib/auth'
import {
  setOrderDetails,
  deliverOrder,
  cancelOrder,
  releaseStaleReservations,
  type DeliveryLineInput,
  type OrderDetailsInput,
} from '@/lib/site/salesOrders'

/**
 * Order actions.
 *
 * Delivering hands back the id of the draft invoice it raised rather than
 * redirecting, so the screen can send the user straight to the till to take
 * payment — the delivery is only half the job.
 */

type ActionResult = { ok: true; message: string; invoiceId?: number } | { ok: false; error: string }

export async function saveDetailsAction(
  documentId: number,
  input: OrderDetailsInput,
): Promise<ActionResult> {
  const siteId = await requireSiteId()
  const result = await setOrderDetails(siteId, documentId, input)
  if (!result.ok) return result

  revalidatePath(`/sales/orders/${documentId}`)
  revalidatePath('/sales/orders')
  return { ok: true, message: 'Delivery details saved.' }
}

export async function deliverAction(
  documentId: number,
  lines: DeliveryLineInput[],
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await deliverOrder(siteId, actor, documentId, lines)
  if (!result.ok) return result

  revalidatePath(`/sales/orders/${documentId}`)
  revalidatePath('/sales/orders')
  revalidatePath('/sales')

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
  const { siteId, actor } = await requireActor()

  const result = await cancelOrder(siteId, actor, documentId, reason)
  if (!result.ok) return result

  revalidatePath(`/sales/orders/${documentId}`)
  revalidatePath('/sales/orders')
  return {
    ok: true,
    message:
      result.released > 0
        ? `Cancelled — ${result.released} released back to available stock.`
        : 'Order cancelled.',
  }
}

export async function releaseStaleAction(): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const released = await releaseStaleReservations(siteId, actor)
  revalidatePath('/sales/orders')

  return {
    ok: true,
    message:
      released.length === 0
        ? 'Nothing has expired — every reservation is still current.'
        : `${released.length} expired reservation${released.length === 1 ? '' : 's'} released.`,
  }
}

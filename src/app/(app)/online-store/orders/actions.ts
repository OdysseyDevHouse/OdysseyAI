'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  acceptOrder,
  archiveOrder,
  cancelOrder,
  moveOrderStatus,
  type AcceptResult,
  type ActionResult,
} from '@/lib/site/onlineOrders'

/**
 * Server actions for the online order queue.
 *
 * The rules live in the data layer so nothing can accept an order by a route
 * that skips them. What these add is the audit trail — accepting writes a real
 * sale, and cancelling turns a customer away, so both have to be answerable
 * for later.
 */

export async function acceptOrderAction(orderId: number): Promise<AcceptResult> {
  const { siteId, actor } = await requireActor()
  const result = await acceptOrder(siteId, orderId, actor)
  if (!result.ok) return result

  // An acknowledgement is not an acceptance; logging it as one would put a
  // second "accepted" against an order nobody touched twice.
  if (!result.alreadyAccepted) {
    await logActivity(siteId, actor, {
      entity: 'online_store',
      entityId: orderId,
      action: 'accept',
      detail:
        result.repriced.length > 0
          ? `Online order accepted — ${result.repriced.length} line(s) re-priced since ordering`
          : 'Online order accepted',
    })
  }

  revalidatePath('/online-store/orders')
  return result
}

export async function moveOrderAction(orderId: number, statusId: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await moveOrderStatus(siteId, orderId, statusId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: orderId,
    action: 'status',
    detail: 'Online order moved along',
  })

  revalidatePath('/online-store/orders')
  return result
}

export async function cancelOrderAction(orderId: number, reason: string): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await cancelOrder(siteId, orderId, reason)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: orderId,
    action: 'cancel',
    detail: `Online order cancelled — ${reason.trim().slice(0, 160)}`,
  })

  revalidatePath('/online-store/orders')
  return result
}

export async function archiveOrderAction(
  orderId: number,
  archived: boolean,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await archiveOrder(siteId, orderId, archived)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: orderId,
    action: archived ? 'archive' : 'restore',
    detail: archived ? 'Online order archived' : 'Online order restored',
  })

  revalidatePath('/online-store/orders')
  return result
}

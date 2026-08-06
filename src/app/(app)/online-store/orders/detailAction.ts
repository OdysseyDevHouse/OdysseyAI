'use server'

import { requireSiteId } from '@/lib/auth'
import { getOrder, type OnlineOrderDetail } from '@/lib/site/onlineOrders'

/**
 * One order with its lines, for the detail panel.
 *
 * Its own file because everything in actions.ts MUTATES, and a reader living
 * among them invites the next person to add a write here without the audit
 * logging the others all carry.
 */
export async function getOrderAction(
  orderId: number,
): Promise<{ ok: true; order: OnlineOrderDetail } | { ok: false; error: string }> {
  const siteId = await requireSiteId()
  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }
  return { ok: true, order }
}

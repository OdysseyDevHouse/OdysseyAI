'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  deleteOrderStatus,
  reorderOrderStatuses,
  saveOrderStatus,
  type OrderStatusInput,
  type SaveResult,
} from '@/lib/site/onlineStore'

/**
 * Editing the order pipeline.
 *
 * Guarded on `online.edit`, and audited — changing what a status sends changes
 * what a shop's customers receive, which is exactly the kind of thing someone
 * needs to be able to look back at when a customer says they were told
 * something odd.
 *
 * Reordering is NOT audited: it is a display decision, it happens by the
 * handful while someone arranges the list, and a log entry per nudge would
 * bury the changes that matter.
 */

export async function saveStatusAction(input: OrderStatusInput): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveOrderStatus(siteId, input)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: input.id,
    action: input.id ? 'status_update' : 'status_create',
    detail: `Order status ${input.id ? 'updated' : 'added'}: ${input.name.trim()}`,
  })

  revalidatePath('/online-store/statuses')
  revalidatePath('/online-store/orders')
  return { ok: true }
}

export async function deleteStatusAction(id: number, name: string): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteOrderStatus(siteId, id)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    // No id: the row is gone, and this entry is now the only record of it.
    entityId: null,
    action: 'status_delete',
    detail: `Order status deleted: ${name}`,
  })

  revalidatePath('/online-store/statuses')
  revalidatePath('/online-store/orders')
  return { ok: true }
}

export async function reorderStatusesAction(ids: number[]): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx

  const result = await reorderOrderStatuses(ctx.siteId, ids)
  if (!result.ok) return result

  revalidatePath('/online-store/statuses')
  revalidatePath('/online-store/orders')
  return { ok: true }
}

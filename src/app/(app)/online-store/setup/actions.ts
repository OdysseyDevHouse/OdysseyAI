'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  deleteDeliveryZone,
  getOnlineSettings,
  saveDeliveryZone,
  saveOnlineSettings,
  type OnlineSettingsInput,
  type SaveResult,
  type ZoneInput,
} from '@/lib/site/onlineStore'

/**
 * Server actions for the online store's Setup screen.
 *
 * The completeness checks live in the data layer rather than here, so the
 * storefront cannot be opened by any other caller that skips this screen.
 * What these add is the audit trail and the cache invalidation.
 */

export async function saveSettingsAction(input: OnlineSettingsInput): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // Read the row before writing so the log can say what actually changed.
  // Opening a public storefront is the most consequential switch in the app
  // and "who turned this on, and when" must be answerable.
  const before = await getOnlineSettings(siteId)

  const result = await saveOnlineSettings(siteId, input, actor.userName)
  if (!result.ok) return result

  if (before.isEnabled !== input.isEnabled) {
    await logActivity(siteId, actor, {
      entity: 'online_store',
      entityId: null,
      action: input.isEnabled ? 'opened' : 'closed',
      detail: input.isEnabled
        ? `Storefront opened to the public (${input.publishMode}, ${
            input.collectEnabled && input.deliverEnabled
              ? 'collection and delivery'
              : input.deliverEnabled
                ? 'delivery only'
                : 'collection only'
          })`
        : 'Storefront closed',
    })
  } else {
    await logActivity(siteId, actor, {
      entity: 'online_store',
      entityId: null,
      action: 'update',
      detail: 'Online store settings changed',
    })
  }

  revalidatePath('/online-store/setup')
  return { ok: true }
}

export async function saveZoneAction(input: ZoneInput): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await saveDeliveryZone(siteId, input)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: input.id ?? null,
    action: input.id ? 'update' : 'create',
    detail: `Delivery area “${input.name.trim()}”`,
  })

  revalidatePath('/online-store/setup')
  return { ok: true }
}

export async function deleteZoneAction(id: number): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await deleteDeliveryZone(siteId, id)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: id,
    action: 'delete',
    detail: 'Delivery area removed',
  })

  revalidatePath('/online-store/setup')
  return { ok: true }
}

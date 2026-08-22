'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorForModule } from '@/lib/auth'
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
import { groupForSite, membersOfGroup, setGroupOnlineMode } from '@/lib/storeGroups'
import { setBranchPin, syncBranchPin } from '@/lib/control/storeBranches'

/**
 * What the group-storefront forms below report back.
 *
 * Kept separate from SaveResult because these are useActionState forms: what a
 * form action returns is what the screen re-renders from, and a discriminated
 * ok/error union reads badly as the initial state of a form nobody has
 * submitted yet.
 */
export type GroupFormState = {
  error: string | null
}

/**
 * Server actions for the online store's Setup screen.
 *
 * The completeness checks live in the data layer rather than here, so the
 * storefront cannot be opened by any other caller that skips this screen.
 * What these add is the audit trail and the cache invalidation.
 */

export async function saveSettingsAction(input: OnlineSettingsInput): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
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
  const ctx = await actorForModule('online_store', 'online.edit')
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
  const ctx = await actorForModule('online_store', 'online.edit')
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

/* ── One shop for a group of stores ──────────────────────────────────────────
 *
 * These sit on the online store's own Setup screen because that is the screen
 * somebody opens when they are deciding what their shop IS to a shopper. They
 * were previously on Setup → Linked stores, which is where the group is BUILT —
 * a different question, asked once, usually by a different person.
 *
 * The guard stays `multi_branch` + `setup.edit`, unchanged by the move. Deciding
 * that ten shops answer to one storefront is a group-level change, and moving
 * the screen must not quietly widen who may make it: somebody with `online.edit`
 * at one branch may configure that branch's shop, not the whole chain's.
 */

/**
 * Switches the group's shared storefront on or off.
 *
 * The preconditions live in setGroupOnlineMode, not here — this action is one
 * caller of it and a rule enforced only in a screen is a rule the next caller
 * skips. All this does is establish who is asking.
 */
export async function setGroupStorefrontAction(
  _prev: GroupFormState,
  form: FormData,
): Promise<GroupFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const group = await groupForSite(siteId)
  if (!group) return { error: 'Link a store first — there is no group to switch on.' }

  const result = await setGroupOnlineMode(group.id, form.get('enabled') === 'on')
  if (!result.ok) return { error: result.error }

  revalidatePath('/online-store/setup')
  return { error: null }
}

/**
 * Pins a branch on the map, or clears its pin.
 *
 * Both fields empty clears it deliberately — that is how a shop pinned in the
 * wrong place is un-pinned rather than left somewhere plausible but wrong. An
 * unpinned branch still appears in the picker, chosen by name instead of by
 * distance, so clearing one costs sorting and never a sale.
 *
 * The store being pinned must be a member of the caller's own group. Without
 * that check this action would write a row for any site id posted to it.
 */
export async function setBranchPinAction(
  _prev: GroupFormState,
  form: FormData,
): Promise<GroupFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const targetSiteId = Number(form.get('siteId'))
  if (!Number.isFinite(targetSiteId) || targetSiteId <= 0) {
    return { error: 'That store is no longer linked.' }
  }

  const group = await groupForSite(siteId)
  if (!group) return { error: 'That store is no longer linked.' }
  const members = await membersOfGroup(group.id)
  if (!members.some((m) => m.siteId === targetSiteId)) {
    return { error: 'That store is not in this group.' }
  }

  const rawLat = String(form.get('latitude') ?? '').trim()
  const rawLng = String(form.get('longitude') ?? '').trim()

  if (rawLat === '' && rawLng === '') {
    const cleared = await setBranchPin(targetSiteId, null, null)
    if (!cleared.ok) return { error: cleared.error }
    revalidatePath('/online-store/setup')
    return { error: null }
  }

  // Number('') is 0, which would silently put a half-filled form in the Gulf of
  // Guinea. Both fields are parsed strictly and a blank one is not a zero.
  const latitude = rawLat === '' ? Number.NaN : Number(rawLat)
  const longitude = rawLng === '' ? Number.NaN : Number(rawLng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: 'Enter both a latitude and a longitude, or clear both.' }
  }

  const result = await setBranchPin(targetSiteId, latitude, longitude)
  if (!result.ok) return { error: result.error }

  revalidatePath('/online-store/setup')
  return { error: null }
}

/**
 * Refreshes the published copy of every branch in the group.
 *
 * The copy is written whenever a shop saves its online-store settings, so this
 * exists for the cases that bypass that: a shop migrated after the group was
 * built, or a pin edited directly in its own database. Reported per store rather
 * than aborting, because one unreachable branch must not stop the other nine
 * being refreshed.
 */
export async function refreshBranchPinsAction(
  _prev: GroupFormState,
  _form: FormData,
): Promise<GroupFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const group = await groupForSite(siteId)
  if (!group) return { error: 'Link a store first.' }

  const members = await membersOfGroup(group.id)
  const results = await Promise.all(
    members.filter((m) => m.hasDatabase).map((m) => syncBranchPin(m.siteId)),
  )
  const failed = results.filter((r) => !r.ok).length

  revalidatePath('/online-store/setup')
  return failed === 0
    ? { error: null }
    : {
        error: `${failed} store${failed === 1 ? '' : 's'} could not be read. The rest were refreshed.`,
      }
}

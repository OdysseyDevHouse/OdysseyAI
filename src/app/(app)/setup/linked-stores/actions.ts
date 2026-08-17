'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, actorForModule, actorForOrThrow } from '@/lib/auth'
import {
  groupForSite,
  createGroup,
  addMember,
  removeMember,
  setMemberSharing,
  setGroupOnlineMode,
} from '@/lib/storeGroups'
import { setBranchPin, syncBranchPin } from '@/lib/control/storeBranches'

export type LinkFormState = { error: string | null }

/**
 * Links another store to this one, creating the group on first use.
 *
 * The group is created lazily rather than up front: a standalone store needs no
 * group row, and creating one on the first link keeps the common single-store
 * case free of setup.
 */
export async function linkStoreAction(
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const targetSiteId = Number(form.get('siteId'))

  if (!Number.isFinite(targetSiteId) || targetSiteId <= 0) {
    return { error: 'Choose a store to link.' }
  }
  if (targetSiteId === siteId) {
    return { error: 'A store cannot be linked to itself.' }
  }

  let group = await groupForSite(siteId)
  if (!group) {
    const name = String(form.get('groupName') ?? '').trim() || 'Store group'
    const groupId = await createGroup(name, siteId)
    // The current store joins its own new group first, so the group is never
    // left holding only the store that was just added. It shares by definition —
    // it is the file the others are being linked to.
    await addMember(groupId, siteId, {
      position: 0,
      sharesProducts: true,
      sharesDepartments: true,
    })
    group = await groupForSite(siteId)
  }
  if (!group) return { error: 'Could not create the store group.' }

  // Linked but NOT sharing: the store may already hold products, and merging
  // two populated product files is not something this app can undo. Sharing is
  // switched on deliberately once the store is empty.
  await addMember(group.id, targetSiteId, { position: 1, sharesProducts: false })

  revalidatePath('/setup/linked-stores')
  return { error: null }
}

export async function unlinkStoreAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('setup.edit')
  const { siteId } = ctx
  const targetSiteId = Number(form.get('siteId'))
  const group = await groupForSite(siteId)
  if (group && Number.isFinite(targetSiteId)) {
    await removeMember(group.id, targetSiteId)
  }
  revalidatePath('/setup/linked-stores')
}

export async function updateSharingAction(
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const targetSiteId = Number(form.get('siteId'))
  const group = await groupForSite(siteId)

  if (!group || !Number.isFinite(targetSiteId)) {
    return { error: 'That store is no longer linked.' }
  }

  const result = await setMemberSharing(group.id, targetSiteId, {
    sharesProducts: form.get('sharesProducts') === 'on',
    sharesDepartments: form.get('sharesDepartments') === 'on',
    sharesCost: form.get('sharesCost') === 'on',
    sharesSelling: form.get('sharesSelling') === 'on',
  })

  // The "store must be empty" rule can only be judged server-side, so a refusal
  // comes back as a message rather than being silently ignored.
  if (!result.ok) return { error: result.error }

  revalidatePath('/setup/linked-stores')
  return { error: null }
}

/**
 * Switches the group's shared storefront on or off.
 *
 * The preconditions live in setGroupOnlineMode, not here — this action is one
 * caller of it and a rule enforced only in a screen is a rule the next caller
 * skips. All this does is establish who is asking.
 */
export async function setGroupStorefrontAction(
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const group = await groupForSite(siteId)
  if (!group) return { error: 'Link a store first — there is no group to switch on.' }

  const result = await setGroupOnlineMode(group.id, form.get('enabled') === 'on')
  if (!result.ok) return { error: result.error }

  revalidatePath('/setup/linked-stores')
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
  _prev: LinkFormState,
  form: FormData,
): Promise<LinkFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const targetSiteId = Number(form.get('siteId'))
  if (!Number.isFinite(targetSiteId) || targetSiteId <= 0) {
    return { error: 'That store is no longer linked.' }
  }

  const group = await groupForSite(siteId)
  if (!group) return { error: 'That store is no longer linked.' }
  const { membersOfGroup } = await import('@/lib/storeGroups')
  const members = await membersOfGroup(group.id)
  if (!members.some((m) => m.siteId === targetSiteId)) {
    return { error: 'That store is not in this group.' }
  }

  const rawLat = String(form.get('latitude') ?? '').trim()
  const rawLng = String(form.get('longitude') ?? '').trim()

  if (rawLat === '' && rawLng === '') {
    const cleared = await setBranchPin(targetSiteId, null, null)
    if (!cleared.ok) return { error: cleared.error }
    revalidatePath('/setup/linked-stores')
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

  revalidatePath('/setup/linked-stores')
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
  _prev: LinkFormState,
  _form: FormData,
): Promise<LinkFormState> {
  const ctx = await actorForModule('multi_branch', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const group = await groupForSite(siteId)
  if (!group) return { error: 'Link a store first.' }

  const { membersOfGroup } = await import('@/lib/storeGroups')
  const members = await membersOfGroup(group.id)
  const results = await Promise.all(
    members.filter((m) => m.hasDatabase).map((m) => syncBranchPin(m.siteId)),
  )
  const failed = results.filter((r) => !r.ok).length

  revalidatePath('/setup/linked-stores')
  return failed === 0
    ? { error: null }
    : {
        error: `${failed} store${failed === 1 ? '' : 's'} could not be read. The rest were refreshed.`,
      }
}

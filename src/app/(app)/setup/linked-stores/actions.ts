'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId } from '@/lib/auth'
import {
  groupForSite,
  createGroup,
  addMember,
  removeMember,
  setMemberSharing,
} from '@/lib/storeGroups'

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
  const siteId = await requireSiteId()
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
  const siteId = await requireSiteId()
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
  const siteId = await requireSiteId()
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

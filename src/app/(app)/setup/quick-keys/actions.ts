'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  listQuickKeys,
  createQuickKey,
  createQuickKeyGroup,
  moveQuickKey,
  updateQuickKey,
  deleteQuickKey,
  ensureSupervisorGroup,
  type SaveResult,
} from '@/lib/site/quickKeys'
import type { QuickKeySection, QuickKeyTarget } from '@/lib/quickKeys'

/**
 * The quick-key designer's actions.
 *
 * ── EVERY ONE RETURNS THE WHOLE FRESH LIST ────────────────────────────────
 *
 * Not the changed key, and not "ok". Positions are renumbered server-side on every
 * move, group and delete — so a canvas that applied its own guess at the new order
 * would drift from what the till is about to draw, and the drift would only show up
 * after a reload. Replacing the state wholesale costs one small payload and removes a
 * whole class of "the designer and the till disagree" bug.
 *
 * ── GUARDED ON setup.edit, ONE CAPABILITY THROUGHOUT ──────────────────────
 *
 * Arranging till buttons is configuration, like tender types and terminals beside it.
 * Not `sales.till`: a cashier who may USE the keys has no business rearranging them,
 * and the person who does this is the same person who set the shop up.
 *
 * The guard is the real boundary. A server action is a public endpoint, so hiding the
 * screen changes what is easy rather than what is possible.
 *
 * ── AND NOTHING HERE IS WRITTEN TO THE ACTIVITY LOG ───────────────────────
 *
 * Matching every other setup screen. `activity_log` is about what people did to master
 * data and to money — who changed a price, who put a customer on hold — and its
 * `entity` list has no member that a till button honestly belongs to. Arranging keys is
 * also a rapid, exploratory act: a shop lays out its bar with twenty drags in a minute,
 * and twenty "moved a key" rows would bury the entries somebody actually needs to find.
 *
 * The arrangement IS its own record — the keys are right there on the screen. If this
 * ever needs a trail, the honest fix is a `setup` entity on ActivityEntity rather than
 * borrowing one that means something else.
 */

export type QuickKeysResult = SaveResult

export async function listQuickKeysAction(
  section: QuickKeySection = 'main',
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* Created on read rather than by a migration seed, because a shop that has never
     opened this screen has no keys at all and the folder would be the only thing on an
     otherwise empty canvas. Idempotent, so calling it on every load is free. */
  await ensureSupervisorGroup(siteId)
  return { ok: true, keys: await listQuickKeys(siteId, section) }
}

export async function createQuickKeyAction(input: {
  section?: QuickKeySection
  parentId?: number | null
  target: QuickKeyTarget
  caption?: string
  icon?: string
  colourToken?: string
  requireAuth?: boolean
}): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await createQuickKey(siteId, input)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

export async function createQuickKeyGroupAction(
  input: { section?: QuickKeySection; caption: string; icon?: string; colourToken?: string },
  memberIds: number[],
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await createQuickKeyGroup(siteId, input, memberIds)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

export async function moveQuickKeyAction(
  id: number,
  destination: { parentId: number | null; index: number },
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await moveQuickKey(siteId, id, destination)
  if (result.ok) revalidatePath('/setup/quick-keys')
  return result
}

export async function updateQuickKeyAction(
  id: number,
  input: {
    caption?: string
    icon?: string
    colourToken?: string
    requireAuth?: boolean
    isHidden?: boolean
  },
): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await updateQuickKey(siteId, id, input)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}

export async function deleteQuickKeyAction(id: number): Promise<QuickKeysResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await deleteQuickKey(siteId, id)
  if (!result.ok) return result


  revalidatePath('/setup/quick-keys')
  return result
}


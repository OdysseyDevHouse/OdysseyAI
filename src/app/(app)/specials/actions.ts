'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  deleteSpecial,
  reorderSpecials,
  saveSpecial,
  setSpecialActive,
  type ActionResult,
  type SpecialInput,
} from '@/lib/site/specials'

/**
 * Editing the shop's promotions.
 *
 * Guarded on `products.edit` — a special changes what things sell for, which
 * is the same authority as changing a price, not a separate one.
 *
 * Every change is audited. A promotion that ran at the wrong discount, or ran
 * when it should not have, is exactly the kind of thing someone needs to be
 * able to trace back to a person and a time.
 */

export async function saveSpecialAction(input: SpecialInput): Promise<ActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveSpecial(siteId, input, actor.userName ?? '')
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'special',
    entityId: result.id,
    action: input.id ? 'update' : 'create',
    detail: `Special ${input.id ? 'changed' : 'created'}: ${input.name.trim()}`,
  })

  revalidatePath('/specials')
  return { ok: true }
}

export async function deleteSpecialAction(id: number, name: string): Promise<ActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteSpecial(siteId, id)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'special',
    // The row is gone; this entry is now the only record that it existed.
    entityId: null,
    action: 'delete',
    detail: `Special deleted: ${name}`,
  })

  revalidatePath('/specials')
  return { ok: true }
}

export async function setSpecialActiveAction(
  id: number,
  active: boolean,
  name: string,
): Promise<ActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setSpecialActive(siteId, id, active)
  if (!result.ok) return result

  // Audited, unlike reordering: switching a special off is how a promotion is
  // ended early, and "when did we stop it" is a real question.
  await logActivity(siteId, actor, {
    entity: 'special',
    entityId: id,
    action: 'update',
    detail: `Special ${active ? 'switched on' : 'switched off'}: ${name}`,
  })

  revalidatePath('/specials')
  return { ok: true }
}

export async function reorderSpecialsAction(ids: number[]): Promise<ActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  // Not audited: the order is nudged repeatedly while someone arranges the
  // list, and an entry per nudge would bury the changes that matter.
  const result = await reorderSpecials(ctx.siteId, ids)
  if (!result.ok) return result

  revalidatePath('/specials')
  return { ok: true }
}

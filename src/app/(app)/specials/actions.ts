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

/**
 * Push one promotion out to the other stores in the group.
 *
 * ── THE SAME CAPABILITY, AT THE OTHER END ────────────────────────────────
 *
 * `products.edit` on the ORIGIN. A person who may set a promotion here may push
 * it, and `fanoutSpecial` refuses any target that `linkedStores` does not
 * return — which is what enforces the group membership and the multi-branch
 * entitlement. Checking a capability at the far site would be checking it for
 * the wrong person: nobody is signed in over there.
 *
 * Never throws on one store failing. The result says what happened at each,
 * because "nineteen worked and Sea Point was asleep" is the answer, and an
 * exception would have thrown away the nineteen.
 */
export async function fanoutSpecialAction(
  id: number,
  targetSiteIds: number[],
): Promise<
  { ok: true; outcomes: import('@/lib/site/specialFanout').FanoutOutcome[] } | { ok: false; error: string }
> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const { listSpecials } = await import('@/lib/site/specials')
  const special = (await listSpecials(siteId)).find((s) => s.id === id)
  if (!special) return { ok: false, error: 'That special no longer exists.' }

  const { fanoutSpecial } = await import('@/lib/site/specialFanout')
  const outcomes = await fanoutSpecial(siteId, special, targetSiteIds, actor.userName ?? '')

  const worked = outcomes.filter((o) => o.ok).length
  await logActivity(siteId, actor, {
    entity: 'special',
    entityId: id,
    action: 'update',
    detail:
      `Special pushed to ${worked} of ${outcomes.length} store(s): ${special.name}` +
      // The failures by name, because an activity line saying "19 of 20" and
      // nothing else leaves someone to work out which one.
      (worked === outcomes.length
        ? ''
        : ` — failed at ${outcomes.filter((o) => !o.ok).map((o) => o.storeName).join(', ')}`),
  })

  return { ok: true, outcomes }
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

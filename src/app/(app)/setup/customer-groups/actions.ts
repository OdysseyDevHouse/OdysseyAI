'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
  type GroupInput,
} from '@/lib/site/customerLookups'

/**
 * Maintaining the customer group list.
 *
 * The model layer has had full CRUD since 012; what was missing was any caller.
 * These are that caller — thin, because every rule that matters (the name
 * clash, the bounds, the refusal to delete a group still in use) already lives
 * in customerLookups.ts and is shared with the CSV importer.
 *
 * `setup.edit` rather than `customers.edit`: a group changes the terms every
 * NEW account in it starts on, which is a configuration decision rather than
 * day-to-day debtors work. The page guards on the same capability, but the
 * action is the real boundary — a page guard only stops navigation.
 */

export type GroupActionResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Which screens go stale when a group changes.
 *
 * Every customer screen renders the group picker or filters by it, and the till
 * resolves a price structure through the group — so a renamed or deactivated
 * group that only refreshed this page would keep serving the old list at the
 * counter.
 */
function revalidateGroupScreens() {
  revalidatePath('/setup/customer-groups')
  revalidatePath('/customers')
  revalidatePath('/customers/new')
  revalidatePath('/customers/age-analysis')
  revalidatePath('/pos')
}

export async function saveCustomerGroupAction(
  input: GroupInput,
  id?: number,
): Promise<GroupActionResult> {
  const ctx = await actorForModule('customers', 'setup.edit')
  if ('ok' in ctx) return ctx

  const result = id
    ? await updateCustomerGroup(ctx.siteId, id, input)
    : await createCustomerGroup(ctx.siteId, input)
  if (!result.ok) return result

  revalidateGroupScreens()
  return result
}

export async function deleteCustomerGroupAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('customers', 'setup.edit')
  if ('ok' in ctx) return ctx

  // Refuses rather than cascades when accounts still point at the group — the
  // FK is ON DELETE SET NULL, so deleting one in use would quietly unassign
  // every account on it. The message names the count and offers deactivating.
  const result = await deleteCustomerGroup(ctx.siteId, id)
  if (!result.ok) return result

  revalidateGroupScreens()
  return result
}

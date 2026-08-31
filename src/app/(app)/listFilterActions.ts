'use server'

import { actorFor } from '@/lib/auth'
import type { Capability } from '@/lib/site/permissions'
import { rememberFilters, forgetFilters } from '@/lib/site/listFilterMemory'
import { decodeFilters, encodeFilters } from '@/lib/listFilters'
import type { ListKey } from '@/lib/site/listColumns'

/**
 * Remember (or forget) the advanced filter on a master list.
 *
 * ── THE CAPABILITY IS PER LIST ─────────────────────────────────────────────
 *
 * One action for three screens, but NOT one permission: somebody who may see
 * the catalogue is not thereby allowed to know the customer book exists. The
 * list key chooses the capability, and a key that is not in this map is
 * refused rather than defaulted — a new list must state its own permission
 * here before it can store anything.
 *
 * A client component is not a boundary and neither is a hidden button, so this
 * asks for itself. The VIEW capability rather than an edit one, because
 * remembering a filter is a read-side convenience: anyone who may look at the
 * list may keep their own place in it.
 *
 * The value is round-tripped through the codec rather than stored as it
 * arrived, so what reaches the database is always something the parser
 * produces — a hand-crafted call cannot park arbitrary text in a column that is
 * later read straight back into a URL. An empty string forgets.
 *
 * Fails SILENTLY on purpose. This runs alongside a navigation the user has
 * already made; a toast reading "could not remember your filter" would
 * interrupt a working list to report on something nobody asked for out loud.
 */
const VIEW_CAPABILITY: Record<ListKey, Capability> = {
  products: 'products.view',
  customers: 'customers.view',
  suppliers: 'suppliers.view',
}

export async function rememberListFiltersAction(
  listKey: ListKey,
  encoded: string,
): Promise<void> {
  const capability = VIEW_CAPABILITY[listKey]
  if (!capability) return

  const ctx = await actorFor(capability)
  if ('ok' in ctx) return

  const { siteId, actor } = ctx

  if (!encoded) {
    await forgetFilters(siteId, listKey, actor.userId)
    return
  }

  await rememberFilters(siteId, listKey, actor.userId, encodeFilters(decodeFilters(encoded)))
}

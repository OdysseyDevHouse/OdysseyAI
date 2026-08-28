'use server'

import { actorFor } from '@/lib/auth'
import { rememberFilters, forgetFilters } from '@/lib/site/listFilterMemory'
import { decodeFilters, encodeFilters } from '@/lib/listFilters'

/**
 * Remember (or forget) the advanced filter on the products list.
 *
 * A hidden button is not a boundary and neither is a client component, so this
 * asks for the capability itself — `products.view`, because remembering a
 * filter is a read-side preference and anyone who may see the list may keep
 * their own place in it.
 *
 * The value is round-tripped through the codec rather than stored as it
 * arrived: what reaches the database is then always something the parser
 * produces, so a hand-crafted call cannot park arbitrary text in a column that
 * is later read straight back into a URL. An empty string forgets.
 *
 * Fails silently on purpose. This is a convenience running alongside a
 * navigation the user has already made; a toast saying "could not remember your
 * filter" would interrupt a working list to report on something nobody asked
 * for out loud.
 */
export async function rememberProductFiltersAction(encoded: string): Promise<void> {
  const ctx = await actorFor('products.view')
  if ('ok' in ctx) return

  const { siteId, actor } = ctx

  if (!encoded) {
    await forgetFilters(siteId, 'products', actor.userId)
    return
  }

  const clean = encodeFilters(decodeFilters(encoded))
  await rememberFilters(siteId, 'products', actor.userId, clean)
}

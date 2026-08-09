'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  setProductVisibility,
  setProductVisibilityBulk,
  type ProductVisibilityOptions,
  type SaveResult,
} from '@/lib/site/onlineStore'

/**
 * Publishing a product puts it in front of the public, so these are audited the
 * same way the department switches and the store's own on/off are.
 */
export async function setProductVisibilityAction(
  productId: number,
  name: string,
  showOnline: boolean,
): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setProductVisibility(siteId, productId, showOnline)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: productId,
    action: showOnline ? 'publish' : 'unpublish',
    detail: `Product “${name}” ${showOnline ? 'shown in' : 'hidden from'} the online store`,
  })

  revalidatePath('/online-store/products')
  // The Setup screen's publish counts and its go-live guard read these flags.
  revalidatePath('/online-store/setup')
  return { ok: true }
}

/**
 * The same, for everything the current filter matches.
 *
 * The filter is passed rather than a list of ids: the user is acting on "what I
 * am looking at", which may be four hundred rows across eight pages, and
 * shipping those ids to the server would both be enormous and go stale the
 * moment anything changed.
 */
export async function setVisibilityForFilterAction(
  filter: ProductVisibilityOptions,
  showOnline: boolean,
): Promise<{ ok: true; changed: number } | { ok: false; error: string }> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setProductVisibilityBulk(
    siteId,
    // Rebuilt rather than spread: only these four keys may reach the query, so
    // nothing a caller adds to the object can widen what gets updated.
    {
      search: filter.search,
      departmentIds: filter.departmentIds,
      only: filter.only,
    },
    showOnline,
  )
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: 0,
    action: showOnline ? 'publish' : 'unpublish',
    detail: `${result.changed} product${result.changed === 1 ? '' : 's'} ${
      showOnline ? 'shown in' : 'hidden from'
    } the online store in bulk`,
  })

  revalidatePath('/online-store/products')
  revalidatePath('/online-store/setup')
  return result
}

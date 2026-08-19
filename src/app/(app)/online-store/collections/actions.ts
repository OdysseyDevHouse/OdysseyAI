'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  deleteCollection,
  saveCollection,
  saveCollectionPicks,
  type CollectionInput,
} from '@/lib/site/storefrontCollections'

type Result = { ok: true; id: number } | { ok: false; error: string }

/**
 * Create or change one collection.
 *
 * Everything is coerced inside `saveCollection` — the slug especially, because
 * it becomes a public address and two collections sharing one is two pages at
 * a single URL.
 */
export async function saveCollectionAction(
  id: number | null,
  input: unknown,
): Promise<Result> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveCollection(siteId, id, (input ?? {}) as CollectionInput, actor.userName)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: result.id,
    action: id === null ? 'create' : 'update',
    detail: `Collection “${(input as CollectionInput)?.title ?? ''}” ${id === null ? 'created' : 'changed'}`,
  })

  revalidatePath('/online-store/collections')
  return result
}

/** Replace what a hand-picked collection holds, in the order given. */
export async function savePicksAction(
  collectionId: number,
  productIds: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await saveCollectionPicks(
    siteId,
    collectionId,
    Array.isArray(productIds) ? (productIds as number[]) : [],
  )
  if (!result.ok) return result

  // No activity entry: this fires as somebody arranges a row, and a log with
  // twenty entries for one afternoon's work is one nobody reads. The
  // collection's own save is the event worth recording.
  revalidatePath('/online-store/collections')
  return { ok: true }
}

/** Remove one. Its picks and its built page go with it — both cascade. */
export async function deleteCollectionAction(
  id: number,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  await deleteCollection(siteId, id)

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: id,
    action: 'delete',
    detail: `Collection “${name}” removed`,
  })

  revalidatePath('/online-store/collections')
  return { ok: true }
}

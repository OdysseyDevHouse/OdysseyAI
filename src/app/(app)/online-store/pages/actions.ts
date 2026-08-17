'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  createPage,
  deletePage,
  reorderPages,
  savePageSettings,
  type CreateResult,
  type NewPageInput,
  type PageSettingsInput,
  type SaveResult,
} from '@/lib/site/storefrontPages'

/**
 * The Pages screen's writes.
 *
 * Every one is audited, unlike the builder's autosave: these change whether a
 * page EXISTS and whether the public can reach it, which is exactly the kind
 * of thing somebody needs to be able to look up afterwards.
 *
 * `online.edit` throughout. The action is the real boundary — a hidden menu
 * entry is not one, and these URLs are typeable.
 */

export async function createPageAction(input: NewPageInput): Promise<CreateResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await createPage(siteId, input)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: result.id,
    action: 'create',
    detail: `Page “${input.title}” added`,
  })

  revalidatePath('/online-store/pages')
  revalidatePath('/online-store/builder')
  return result
}

export async function savePageSettingsAction(
  pageId: number,
  input: PageSettingsInput,
): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // `savePageSettings` reads the page from the SITE's own database before
  // writing, so an id belonging to another shop is simply not found. That is
  // the boundary; nothing here needs to re-check it.
  const result = await savePageSettings(siteId, pageId, input)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: pageId,
    action: 'update',
    // Whether the public can reach it is the change worth being able to find
    // later, so it is named rather than folded into "settings changed".
    // Lending a page to a whole branch changes what shoppers see on
    // departments nobody opened, so it is named too rather than folded into
    // "settings changed".
    detail:
      input.isPublished !== undefined
        ? input.isPublished
          ? 'Page switched on'
          : 'Page switched off'
        : input.appliesToChildren !== undefined
          ? input.appliesToChildren
            ? 'Page extended to sub-departments'
            : 'Page limited to its own department'
          : 'Page settings changed',
  })

  revalidatePath('/online-store/pages')
  revalidatePath('/online-store/builder')
  return result
}

export async function deletePageAction(pageId: number): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deletePage(siteId, pageId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: pageId,
    action: 'delete',
    detail: 'Page deleted',
  })

  revalidatePath('/online-store/pages')
  revalidatePath('/online-store/builder')
  return result
}

export async function reorderPagesAction(ids: number[]): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  // Not audited: reordering a nav is cosmetic and reversible, and a log entry
  // per drag would bury the changes that matter.
  const result = await reorderPages(siteId, ids)
  revalidatePath('/online-store/pages')
  return result
}

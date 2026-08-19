'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { saveMenu, type MenuItemInput } from '@/lib/site/storefrontMenus'
import { safeMenuSlug } from '@/lib/storefront/menus'

type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Replace one menu with what the editor is holding.
 *
 * Everything arrives as `unknown` and is coerced inside `saveMenu`. A
 * capability check says who is asking, not what they sent — and this writes
 * the hrefs in the masthead of a public shop, which is the one place a bad
 * value is on every page rather than one.
 */
export async function saveMenuAction(slug: unknown, items: unknown): Promise<SaveResult> {
  const ctx = await actorForModule('online_store', 'online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const menu = safeMenuSlug(slug)
  const result = await saveMenu(siteId, menu, (Array.isArray(items) ? items : []) as MenuItemInput[])
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'menu',
    detail: `The ${menu === 'footer' ? 'footer' : 'main'} menu was changed`,
  })

  revalidatePath('/online-store/menu')
  return { ok: true }
}

'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  discardDraft,
  publishDraft,
  saveDraft,
  saveTheme,
  type SaveResult,
  type StorefrontTheme,
} from '@/lib/site/storefrontLayout'

/**
 * The page builder's writes.
 *
 * Sections arrive from a browser, so they are normalised in `saveDraft` before
 * anything is stored — not merely when rendering. Only `publish` touches what
 * shoppers actually see.
 */

export async function saveDraftAction(sections: unknown): Promise<SaveResult> {
  const { siteId } = await requireActor()
  // Not audited: this fires on every keystroke via autosave, and a log entry
  // per keystroke would bury every other event on the activity tab.
  return saveDraft(siteId, sections)
}

export async function saveThemeAction(theme: Partial<StorefrontTheme>): Promise<SaveResult> {
  const { siteId, actor } = await requireActor()
  const result = await saveTheme(siteId, theme)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'theme',
    detail: 'Storefront appearance changed',
  })

  revalidatePath('/online-store/builder')
  return result
}

export async function publishDraftAction(): Promise<SaveResult> {
  const { siteId, actor } = await requireActor()
  const result = await publishDraft(siteId)
  if (!result.ok) return result

  // This one IS audited: it changes what the public sees.
  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'publish',
    detail: 'Front page published',
  })

  revalidatePath('/online-store/builder')
  return result
}

export async function discardDraftAction(): Promise<SaveResult> {
  const { siteId } = await requireActor()
  const result = await discardDraft(siteId)
  revalidatePath('/online-store/builder')
  return result
}

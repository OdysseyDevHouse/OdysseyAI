'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  publishedProducts,
  storefrontContext,
  type StorefrontProduct,
} from '@/lib/site/storefront'
import {
  addStorefrontImage,
  deleteStorefrontImage,
  listStorefrontImages,
  type StorefrontImage,
} from '@/lib/site/storefrontImages'
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

/**
 * Products the owner can put in a hand-picked row.
 *
 * Deliberately the SAME query the shop uses, so the picker can only offer
 * what a shopper could actually buy. A picker backed by the full product
 * table would happily offer a discontinued line, and the owner would only
 * discover it was missing by looking at the live shop.
 *
 * `ids` fetches specific products regardless of the search term — the picker
 * needs names for what is already picked, and those are ids in the layout
 * with no text to search for.
 */
export async function searchProductsAction(
  search: string,
  ids?: number[],
): Promise<StorefrontProduct[]> {
  // A picker is inside the admin, so the online.edit capability is the gate —
  // NOT the store being open. Building the page before opening is the point.
  const ctx = await actorFor('online.edit')
  // Denied. Return nothing rather than throwing: this is a search-as-you-type
  // and an empty list is the honest answer for someone not allowed to look.
  if ('ok' in ctx) return []
  const { siteId } = ctx
  const context = await storefrontContext(siteId)
  // No context means the shop is not configured enough to have a catalogue.
  if (!context) return []

  if (ids?.length) return publishedProducts(context, { ids, limit: 24 })
  return publishedProducts(context, { search, limit: 20 })
}

/**
 * A page of the catalogue for the "Add products" dialog.
 *
 * Same gate and same query as `searchProductsAction` — the difference is that
 * this one answers with no search term at all. The dialog opens on a list
 * rather than an empty box, because an owner picking a "Specials" row is
 * usually browsing what they have, not recalling a code they already know.
 *
 * 100 is the page size the dialog asks for, and `publishedProducts` clamps its
 * own limit at 120, so the number is honoured rather than quietly reduced.
 */
export async function browseProductsAction(options: {
  search?: string
  departmentId?: number | null
  limit?: number
}): Promise<BrowseResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return { products: [], publishesNothing: false }
  const { siteId } = ctx
  const context = await storefrontContext(siteId)
  if (!context) return { products: [], publishesNothing: true }

  const products = await publishedProducts(context, {
    search: options.search ?? '',
    departmentId: options.departmentId ?? undefined,
    limit: options.limit ?? 100,
  })

  /*
   * An empty result has two very different causes, and the dialog must not
   * blame the wrong one.
   *
   * A store on the default 'departments' publish mode with nothing ticked
   * publishes NOTHING — so every search comes back empty no matter what is
   * typed. Telling that owner "nothing matches those filters" sends them to
   * retype a search that was never going to work; the fix is two screens away
   * in Setup or Departments. Only ask the unfiltered question when the
   * filtered one came back empty, so the common case costs no extra query.
   */
  let publishesNothing = false
  if (products.length === 0) {
    const any = await publishedProducts(context, { limit: 1 })
    publishesNothing = any.length === 0
  }

  return { products, publishesNothing }
}

export type BrowseResult = {
  products: StorefrontProduct[]
  /** The store publishes nothing at all — not merely nothing matching. */
  publishesNothing: boolean
}

export async function saveDraftAction(sections: unknown): Promise<SaveResult> {
  const { siteId } = await requireActor()
  // Not audited: this fires on every keystroke via autosave, and a log entry
  // per keystroke would bury every other event on the activity tab.
  return saveDraft(siteId, sections)
}

export async function saveThemeAction(theme: Partial<StorefrontTheme>): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
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
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
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

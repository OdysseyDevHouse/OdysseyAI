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
  saveTheme,
  type SaveResult,
  type StorefrontTheme,
} from '@/lib/site/storefrontLayout'
import {
  deleteSavedSection,
  discardPageDraft,
  getPage,
  publishPageDraft,
  restoreVersion,
  savePageDraft,
  saveSection,
  schedulePublish,
} from '@/lib/site/storefrontPages'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { createPreviewToken } from '@/lib/previewToken'

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

/**
 * The page id an action was given, once it is known to belong to THIS site.
 *
 * ── WHY EVERY ACTION RE-READS IT ─────────────────────────────────────────
 *
 * A page id arrives from a browser, so it is a claim rather than a fact. The
 * site comes from the session and never from the request — but the ID does not,
 * and `savePageDraft` would happily write to any row number it is handed.
 *
 * `getPage` reads within the site's OWN database (siteDb resolves the
 * connection from the session's site), so a page belonging to another shop
 * simply is not there and the write is refused. That property is the boundary;
 * this helper exists so no action can forget to ask.
 */
async function pageWithin(siteId: number, pageId: unknown): Promise<number | null> {
  const id = Number(pageId)
  if (!Number.isInteger(id) || id <= 0) return null
  return (await getPage(siteId, id)) ? id : null
}

export async function saveDraftAction(pageId: number, sections: unknown): Promise<SaveResult> {
  const { siteId } = await requireActor()
  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }
  // Not audited: this fires on every keystroke via autosave, and a log entry
  // per keystroke would bury every other event on the activity tab.
  return savePageDraft(siteId, id, sections)
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

export async function publishDraftAction(pageId: number): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }

  const page = await getPage(siteId, id)
  // The actor's name travels into the version row, so the history says who
  // replaced what rather than only when.
  const result = await publishPageDraft(siteId, id, actor.userName)
  if (!result.ok) return result

  // This one IS audited: it changes what the public sees. Named, because a
  // shop with eight pages needs the log to say WHICH one went live.
  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: id,
    action: 'publish',
    detail: `Published “${page?.title || 'a page'}”`,
  })

  revalidatePath('/online-store/builder')
  return result
}

/**
 * A link to walk this page's draft on the real storefront.
 *
 * ── WHY THE DRAFT IS FLUSHED FIRST ───────────────────────────────────────
 *
 * The preview renders the SERVER's draft, and the builder autosaves on a
 * debounce — so opening a preview within a second of a keystroke would show
 * the page as it was before that edit. That is the one thing a preview must
 * never do, so the caller's current sections are written before the link is
 * minted rather than trusting the timer to have fired.
 *
 * The pass is short-lived and names one page; see lib/previewToken.ts.
 */
export async function previewLinkAction(
  pageId: number,
  sections: unknown,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }

  const page = await getPage(siteId, id)
  if (!page) return { ok: false, error: 'That page no longer exists.' }

  await savePageDraft(siteId, id, sections)

  const [storeToken, preview] = await Promise.all([
    createPublicStoreToken(siteId),
    createPreviewToken(siteId, id),
  ])

  // Where this page actually lives on the shop. A department page has no slug
  // of its own — it decorates a department — so it previews at that
  // department's URL.
  const path =
    page.kind === 'standard'
      ? `/page/${page.slug}`
      : page.kind === 'department' && page.departmentId
        ? `/c/${page.departmentId}`
        : ''

  return { ok: true, url: `/store/${storeToken}${path}?preview=${preview}` }
}

/**
 * Load an old version back into the builder as a draft.
 *
 * Audited, because it replaces whatever the owner had unpublished — the one
 * thing on this screen that destroys work without a confirmation behind it
 * being obvious. Restoring does NOT go live; see `restoreVersion`.
 */
export async function restoreVersionAction(
  pageId: number,
  versionId: number,
): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }

  const result = await restoreVersion(siteId, id, Number(versionId))
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: id,
    action: 'update',
    detail: 'An earlier version was restored into the draft',
  })

  revalidatePath('/online-store/builder')
  return result
}

/**
 * Set — or clear — when this page publishes itself.
 *
 * The draft is flushed first, for the same reason the preview link flushes it:
 * the scheduler publishes the SERVER's draft, and an edit still sitting in the
 * autosave debounce would be left behind when the moment came. That failure
 * would surface at midnight, on a page nobody is watching.
 */
export async function schedulePublishAction(
  pageId: number,
  at: string,
  sections: unknown,
): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }

  if (at.trim()) await savePageDraft(siteId, id, sections)

  const result = await schedulePublish(siteId, id, at)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: id,
    action: 'update',
    detail: at.trim() ? `Scheduled to publish at ${at}` : 'Scheduled publish cancelled',
  })

  revalidatePath('/online-store/builder')
  return result
}

/** Keep a section to use on another page. */
export async function saveSectionAction(name: string, section: unknown): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const result = await saveSection(ctx.siteId, name, section)
  if (result.ok) revalidatePath('/online-store/builder')
  return result
}

export async function deleteSavedSectionAction(id: number): Promise<SaveResult> {
  const ctx = await actorFor('online.edit')
  if ('ok' in ctx) return ctx
  const result = await deleteSavedSection(ctx.siteId, Number(id))
  if (result.ok) revalidatePath('/online-store/builder')
  return result
}

export async function discardDraftAction(pageId: number): Promise<SaveResult> {
  const { siteId } = await requireActor()
  const id = await pageWithin(siteId, pageId)
  if (id === null) return { ok: false, error: 'That page no longer exists.' }
  const result = await discardPageDraft(siteId, id)
  revalidatePath('/online-store/builder')
  return result
}

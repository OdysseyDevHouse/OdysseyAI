import { readDesignTokens, type DesignTokens } from '@/lib/storefront/tokens'
import 'server-only'
import { siteExecute, siteQueryOne } from '../siteDb'
import {
  defaultSections,
  readTheme,
  safeColour,
  safeDate,
  safeFontKey,
  safeLinkTarget,
  safeUrl,
  type HomeSection,
  type StorefrontTheme,
} from '../storefrontModel'
import {
  discardPageDraft,
  getPageLayout,
  getPublishedPageLayout,
  homePage,
  publishPageDraft,
  savePageDraft,
} from './storefrontPages'

/**
 * The storefront's THEME, and the front page as a convenience.
 *
 * The MODEL — section kinds, caps, normalisation, colour and URL validation —
 * lives in lib/storefrontModel.ts, which carries no `server-only` marker so the
 * builder in the browser can apply the identical rules. This file is only the
 * database half, and re-exports the model so callers have one import.
 *
 * ── PAGES MOVED OUT ──────────────────────────────────────────────────────
 *
 * This file used to own `home_layout` and `home_layout_draft` on the settings
 * row. 070 replaced them with a row per page in `storefront_pages`, and
 * storefrontPages.ts owns that table.
 *
 * What is left here is the THEME — a fixed, small set of scalars that apply to
 * the whole shop, which is why 040 made them columns rather than JSON in the
 * first place. That decision has not changed and a per-page palette is
 * deliberately not offered: one shop, one look.
 *
 * The front-page helpers below remain because the shop's own root route and
 * the builder both want "the theme and the front page" in one call, and
 * threading a page id through every caller to always pass the same one buys
 * nothing. They delegate; they do not read the old columns.
 */

export * from '../storefrontModel'

/* ── Reading and writing ──────────────────────────────────────────────────── */

type Row = Record<string, unknown>

export type LayoutState = {
  theme: StorefrontTheme
  /** What shoppers see. Falls back to the starter page. */
  published: HomeSection[]
  /** What the owner is editing, or null when there is nothing unpublished. */
  draft: HomeSection[] | null
}

/** Just the theme. Every page needs it; only the front page needs the rest. */
export async function getTheme(siteId: number): Promise<StorefrontTheme> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT brand_colour, product_layout, logo_image_id, hero_headline, hero_subtext,
            footer_about, footer_hours, social_facebook, social_instagram,
            social_whatsapp, font_key, share_image_id, allow_indexing,
            announce_text, announce_link, announce_from, announce_until
       FROM online_store_settings WHERE id = 1`,
  )
  return readTheme(row ?? {})
}

export async function getLayout(siteId: number): Promise<LayoutState> {
  const [theme, home] = await Promise.all([getTheme(siteId), homePage(siteId)])

  // No home row at all means 070 has not run on this site. The starter page is
  // the same answer the old code gave for a NULL layout, so a site mid-migration
  // renders rather than throwing.
  if (!home) return { theme, published: defaultSections(), draft: null }

  const layout = await getPageLayout(siteId, home.id)
  return { theme, published: layout.published, draft: layout.draft }
}

/**
 * What the SHOP renders on its front page: published sections only, never a
 * draft, and only those in season.
 *
 * The two gates live in `getPublishedPageLayout` now — see it for why they are
 * evaluated on every read rather than by a nightly job.
 */
export async function getPublishedLayout(
  siteId: number,
): Promise<{ theme: StorefrontTheme; sections: HomeSection[] }> {
  const [theme, home] = await Promise.all([getTheme(siteId), homePage(siteId)])
  if (!home) return { theme, sections: defaultSections().filter((s) => s.enabled) }
  return { theme, sections: await getPublishedPageLayout(siteId, home.id) }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

export async function saveDraft(siteId: number, sections: unknown): Promise<SaveResult> {
  const home = await homePage(siteId)
  if (!home) return { ok: false, error: 'This shop has no front page yet.' }
  return savePageDraft(siteId, home.id, sections)
}

export async function saveTheme(siteId: number, theme: Partial<StorefrontTheme>): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE online_store_settings
        SET brand_colour = ?, product_layout = ?, logo_image_id = ?,
            hero_headline = ?, hero_subtext = ?,
            footer_about = ?, footer_hours = ?, social_facebook = ?,
            social_instagram = ?, social_whatsapp = ?,
            font_key = ?, share_image_id = ?,
            announce_text = ?, announce_link = ?,
            announce_from = ?, announce_until = ?
      WHERE id = 1`,
    [
      safeColour(theme.brandColour),
      theme.productLayout === 'list' ? 'list' : 'grid',
      // An id or nothing. Anything unusable becomes NULL rather than 0, which
      // would be a reference to a picture that cannot exist.
      Number.isInteger(theme.logoImageId) && (theme.logoImageId ?? 0) > 0
        ? theme.logoImageId
        : null,
      (theme.heroHeadline ?? '').slice(0, 120),
      (theme.heroSubtext ?? '').slice(0, 300),
      (theme.footerAbout ?? '').slice(0, 600),
      (theme.footerHours ?? '').slice(0, 400),
      safeUrl(theme.socialFacebook).slice(0, 200),
      safeUrl(theme.socialInstagram).slice(0, 200),
      (theme.socialWhatsapp ?? '').replace(/[^\d+]/g, '').slice(0, 30),
      // A key from the curated list, never a font NAME — see FONT_KEYS.
      safeFontKey(theme.fontKey),
      Number.isInteger(theme.shareImageId) && (theme.shareImageId ?? 0) > 0
        ? theme.shareImageId
        : null,
      /*
       * `allow_indexing` is deliberately NOT written here.
       *
       * 077 added the column and this file READS it (see readTheme), because
       * the storefront's robots tag is the thing that consumes it. But the
       * Setup screen owns writing it — `saveOnlineSettings` in onlineStore.ts
       * — since that is where a shop decides whether it wants search traffic,
       * alongside the public domain a canonical link needs.
       *
       * Two writers on one column is a silent bug: whichever screen saved last
       * would win, and an owner switching indexing on in Setup would find it
       * off again after touching a colour in the builder.
       */
      (theme.announceText ?? '').slice(0, 200),
      // safeLinkTarget, not safeUrl: the strip commonly points at a department
      // inside the shop, and those are relative paths. Same rule a banner uses.
      safeLinkTarget(theme.announceLink).slice(0, 300),
      safeDate(theme.announceFrom),
      safeDate(theme.announceUntil),
    ],
  )
  return { ok: true }
}

/** Make the front page's draft live, and clear it. */
export async function publishDraft(siteId: number): Promise<SaveResult> {
  const home = await homePage(siteId)
  if (!home) return { ok: false, error: 'This shop has no front page yet.' }
  const result = await publishPageDraft(siteId, home.id)
  if (!result.ok) return result
  /*
   * The appearance goes live with the page it was designed against.
   *
   * After the layout rather than before: a publish that half-succeeded
   * should leave the shop looking as it did, not restyled to match a page
   * that never landed. A shop with no appearance draft is the common case
   * and this is a no-op for it.
   */
  return publishThemeTokens(siteId)
}

/** Throw the front page's draft away and go back to what is live. */
export async function discardDraft(siteId: number): Promise<SaveResult> {
  const home = await homePage(siteId)
  // Both halves, because the button says "throw away my changes" and an
  // owner does not think of the colours as a separate set of them.
  await discardThemeTokens(siteId)
  if (!home) return { ok: true }
  return discardPageDraft(siteId, home.id)
}

/* ── The shop's own look ──────────────────────────────────────────────────── */

/**
 * The tokens a SHOPPER sees, and the ones the owner is editing.
 *
 * Two values rather than one because the appearance now has a draft, exactly
 * as the layout does — see 183 on why eight controls earned one where a single
 * colour did not.
 */
export type ThemeTokens = {
  published: DesignTokens
  /** What the owner has unpublished, or null when there is nothing. */
  draft: DesignTokens | null
}

/**
 * Both, for the builder.
 *
 * Parsed through `readDesignTokens` on the way out, so a column holding
 * anything unexpected — a half-written blob, a value from a build that offered
 * a key this one does not — reads as the default look rather than throwing on
 * a public page.
 */
export async function getThemeTokens(siteId: number): Promise<ThemeTokens> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT design_tokens, design_tokens_draft FROM online_store_settings WHERE id = 1`,
  )
  return {
    published: readDesignTokens(parseJson(row?.design_tokens)),
    draft: row?.design_tokens_draft == null ? null : readDesignTokens(parseJson(row.design_tokens_draft)),
  }
}

/**
 * What the SHOP renders: the published tokens, never the draft.
 *
 * A separate function rather than `getThemeTokens().published` so no public
 * route can reach the draft by picking the wrong field off one object.
 */
export async function getPublishedTokens(siteId: number): Promise<DesignTokens> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT design_tokens FROM online_store_settings WHERE id = 1`,
  )
  return readDesignTokens(parseJson(row?.design_tokens))
}

/**
 * Text out of the column, into something `readDesignTokens` can judge.
 *
 * Unparseable is not an error worth raising: the caller's answer to a broken
 * blob and to no blob at all is the same — the default look — and throwing
 * here would take the shop's front page down over its corner radius.
 */
function parseJson(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/** Store what the owner is editing. Normalised on the way in — a draft is untrusted. */
export async function saveThemeTokensDraft(siteId: number, tokens: unknown): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE online_store_settings SET design_tokens_draft = ? WHERE id = 1`,
    [JSON.stringify(readDesignTokens(tokens))],
  )
  return { ok: true }
}

/**
 * Make the appearance draft live, and clear it.
 *
 * Called by `publishDraft` alongside the page, so the look and the layout it
 * was designed against go live together. Publishing with no appearance draft
 * is a no-op rather than an error — most publishes are layout-only.
 */
export async function publishThemeTokens(siteId: number): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE online_store_settings
        SET design_tokens = COALESCE(design_tokens_draft, design_tokens),
            design_tokens_draft = NULL
      WHERE id = 1`,
  )
  return { ok: true }
}

/** Throw the appearance draft away and go back to what is live. */
export async function discardThemeTokens(siteId: number): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE online_store_settings SET design_tokens_draft = NULL WHERE id = 1`,
  )
  return { ok: true }
}

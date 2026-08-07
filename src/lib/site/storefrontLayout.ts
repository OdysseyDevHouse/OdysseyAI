import 'server-only'
import { siteExecute, siteQueryOne } from '../siteDb'
import {
  defaultSections,
  isScheduledNow,
  normaliseSections,
  readTheme,
  safeColour,
  safeUrl,
  shopToday,
  type HomeSection,
  type StorefrontTheme,
} from '../storefrontModel'

/**
 * Reading and writing the storefront's front page.
 *
 * The MODEL — section kinds, caps, normalisation, colour and URL validation —
 * lives in lib/storefrontModel.ts, which carries no `server-only` marker so the
 * builder in the browser can apply the identical rules. This file is only the
 * database half, and re-exports the model so callers have one import.
 */

export * from '../storefrontModel'

/* ── Reading and writing ──────────────────────────────────────────────────── */

type Row = Record<string, unknown>

function parseLayout(value: unknown): HomeSection[] | null {
  if (value === null || value === undefined || value === '') return null
  try {
    return normaliseSections(JSON.parse(String(value)))
  } catch {
    // Unparseable JSON means a corrupted row. Treated as "never published"
    // rather than throwing, so a bad value cannot take the shop down.
    return null
  }
}

export type LayoutState = {
  theme: StorefrontTheme
  /** What shoppers see. Falls back to the starter page. */
  published: HomeSection[]
  /** What the owner is editing, or null when there is nothing unpublished. */
  draft: HomeSection[] | null
}

export async function getLayout(siteId: number): Promise<LayoutState> {
  const row = await siteQueryOne<Row & { home_layout?: unknown }>(
    siteId,
    `SELECT brand_colour, product_layout, logo_image_id, hero_headline, hero_subtext,
            footer_about, footer_hours, social_facebook, social_instagram,
            social_whatsapp, home_layout, home_layout_draft
       FROM online_store_settings WHERE id = 1`,
  )

  if (!row) {
    return {
      theme: readTheme({}),
      published: defaultSections(),
      draft: null,
    }
  }

  return {
    theme: readTheme(row),
    // NULL means "never published" → the starter page. An empty ARRAY means
    // the owner deliberately removed everything, and is respected.
    published: parseLayout(row.home_layout) ?? defaultSections(),
    draft: parseLayout(row.home_layout_draft),
  }
}

/**
 * What the SHOP renders: published sections only, never a draft.
 *
 * Two gates, deliberately separate. `enabled` is the owner saying "not this";
 * the schedule is them saying "not yet" or "not any more". A section fails if
 * either says so, and the builder shows both states differently — off looks
 * off, out-of-season looks dated.
 *
 * Evaluated on every READ rather than by a nightly job that flips flags: a
 * date passing is not an event anybody triggers, so a stored answer would be
 * wrong between the moment the date turned and the moment the job ran. This is
 * the same argument `quoteState` makes about expiry.
 */
export async function getPublishedLayout(
  siteId: number,
): Promise<{ theme: StorefrontTheme; sections: HomeSection[] }> {
  const state = await getLayout(siteId)
  const today = shopToday()
  return {
    theme: state.theme,
    sections: state.published.filter((s) => s.enabled && isScheduledNow(s, today)),
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

export async function saveDraft(siteId: number, sections: unknown): Promise<SaveResult> {
  const clean = normaliseSections(sections)
  await siteExecute(siteId, `UPDATE online_store_settings SET home_layout_draft = ? WHERE id = 1`, [
    JSON.stringify(clean),
  ])
  return { ok: true }
}

export async function saveTheme(siteId: number, theme: Partial<StorefrontTheme>): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE online_store_settings
        SET brand_colour = ?, product_layout = ?, logo_image_id = ?,
            hero_headline = ?, hero_subtext = ?,
            footer_about = ?, footer_hours = ?, social_facebook = ?,
            social_instagram = ?, social_whatsapp = ?
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
    ],
  )
  return { ok: true }
}

/** Make the draft live, and clear it. */
export async function publishDraft(siteId: number): Promise<SaveResult> {
  const state = await getLayout(siteId)
  if (state.draft === null) return { ok: false, error: 'There are no changes to publish.' }

  await siteExecute(
    siteId,
    `UPDATE online_store_settings SET home_layout = ?, home_layout_draft = NULL WHERE id = 1`,
    [JSON.stringify(state.draft)],
  )
  return { ok: true }
}

/** Throw the draft away and go back to what is live. */
export async function discardDraft(siteId: number): Promise<SaveResult> {
  await siteExecute(siteId, `UPDATE online_store_settings SET home_layout_draft = NULL WHERE id = 1`)
  return { ok: true }
}

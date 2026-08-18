import 'server-only'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import {
  DEFAULT_LISTING,
  readBadgeRules,
  readListingPreset,
  writeSet,
  type BadgeRules,
  type ListingPreset,
} from '../storefront/listing'

/**
 * Reading and writing how a listing looks.
 *
 * ── THE CASCADE ──────────────────────────────────────────────────────────
 *
 * A department's own row, else the shop's default row, else the built-in
 * default. Three steps, and the middle one is the reason the table is worth
 * having: a shop with forty departments configures ONE row, and the thirty-nine
 * that never needed a decision keep following it — including as the shop's mind
 * changes later.
 *
 * That is the same shape `departmentPageFor` uses for department pages, and it
 * is deliberately NOT the ancestor walk that one does. A page cascades down a
 * tree because a "Drinks" banner is still true of "Cooldrinks"; a column count
 * is not inherited from a parent aisle in any way an owner would predict, and a
 * two-level fallback is one they can hold in their head.
 */

type Row = Record<string, unknown>

/**
 * The shop's default listing, as a department id.
 *
 * 0 rather than NULL. A UNIQUE index does not constrain NULLs in MySQL, so the
 * first version allowed any number of "the shop's default" rows — every save
 * inserted another one, and the shop's settings became whichever the engine
 * happened to return first. See 186.
 *
 * Safe because `departments.id` is AUTO_INCREMENT and therefore never 0.
 */
const SHOP_DEFAULT = 0

/**
 * Every configured row, keyed by department id — the shop's default under 0.
 *
 * One query rather than one per department: the admin screen lists every
 * department with its effective setting, and doing that a row at a time is a
 * query per aisle for a table that will hold a handful of rows.
 */
export async function listListingPresets(siteId: number): Promise<Map<number, ListingPreset>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT department_id, columns_desktop, columns_phone, per_page, default_sort,
            layout, card_fields, facets,
            badge_new_label, badge_new_days, badge_new_tone,
            badge_best_label, badge_best_tone,
            badge_low_label, badge_low_at, badge_low_tone
       FROM online_listing_presets`,
  )
  const out = new Map<number, ListingPreset>()
  for (const row of rows) {
    const preset = readListingPreset(row)
    out.set(preset.departmentId ?? SHOP_DEFAULT, preset)
  }
  return out
}

/** The shop's default, or the built-in one when nobody has set it. */
export async function shopListingPreset(siteId: number): Promise<ListingPreset> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT department_id, columns_desktop, columns_phone, per_page, default_sort,
            layout, card_fields, facets,
            badge_new_label, badge_new_days, badge_new_tone,
            badge_best_label, badge_best_tone,
            badge_low_label, badge_low_at, badge_low_tone
       FROM online_listing_presets WHERE department_id = 0`,
  )
  return readListingPreset(row)
}

/**
 * What THIS department's listing looks like.
 *
 * Falls back rather than throwing at every step: a listing that cannot render
 * because nobody configured it would be a shop taken down by a settings screen
 * nobody visited.
 */
export async function listingPresetFor(
  siteId: number,
  departmentId: number,
): Promise<ListingPreset> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT department_id, columns_desktop, columns_phone, per_page, default_sort,
            layout, card_fields, facets,
            badge_new_label, badge_new_days, badge_new_tone,
            badge_best_label, badge_best_tone,
            badge_low_label, badge_low_at, badge_low_tone
       FROM online_listing_presets WHERE department_id = ?`,
    [departmentId],
  )
  if (row) return readListingPreset(row)
  return shopListingPreset(siteId)
}

/**
 * Store one listing's settings.
 *
 * `departmentId` null writes the shop's default. Normalised on the way in for
 * the same reason a draft is: this arrives from a browser, and an admin form is
 * no more trustworthy than a shopper's.
 */
export async function saveListingPreset(
  siteId: number,
  preset: ListingPreset,
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = readListingPreset({
    department_id: preset.departmentId,
    columns_desktop: preset.columnsDesktop,
    columns_phone: preset.columnsPhone,
    per_page: preset.perPage,
    default_sort: preset.defaultSort,
    layout: preset.layout,
    card_fields: writeSet(preset.cardFields),
    facets: writeSet(preset.facets),
  })

  await siteExecute(
    siteId,
    `INSERT INTO online_listing_presets
       (department_id, columns_desktop, columns_phone, per_page, default_sort,
        layout, card_fields, facets, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       columns_desktop = VALUES(columns_desktop),
       columns_phone = VALUES(columns_phone),
       per_page = VALUES(per_page),
       default_sort = VALUES(default_sort),
       layout = VALUES(layout),
       card_fields = VALUES(card_fields),
       facets = VALUES(facets),
       updated_at = NOW(),
       updated_by = VALUES(updated_by)`,
    [
      clean.departmentId ?? SHOP_DEFAULT,
      clean.columnsDesktop,
      clean.columnsPhone,
      clean.perPage,
      clean.defaultSort,
      clean.layout,
      writeSet(clean.cardFields),
      writeSet(clean.facets),
      actor.slice(0, 120),
    ],
  )
  return { ok: true }
}

/**
 * Stop overriding: this department follows the shop again.
 *
 * A DELETE rather than a column reading "inherit", so there is one way to be
 * following the default instead of two that have to agree. It also means the
 * shop's later changes reach this department, which is what "follow" has to
 * mean or the word is a lie.
 */
export async function clearListingPreset(siteId: number, departmentId: number): Promise<void> {
  await siteExecute(siteId, `DELETE FROM online_listing_presets WHERE department_id = ?`, [
    departmentId,
  ])
}

export { DEFAULT_LISTING }

/**
 * The shop's badge rules.
 *
 * Its own function rather than a field on the preset, because the two have
 * different scopes: a listing's settings are per department and these are
 * shop-wide, and folding them together would invite a department screen to
 * offer controls that quietly do nothing.
 */
export async function shopBadgeRules(siteId: number): Promise<BadgeRules> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT badge_new_label, badge_new_days, badge_new_tone,
            badge_best_label, badge_best_tone,
            badge_low_label, badge_low_at, badge_low_tone
       FROM online_listing_presets WHERE department_id = 0`,
  )
  return readBadgeRules(row)
}

/** Store them. Normalised on the way in, like everything a form sends. */
export async function saveBadgeRules(
  siteId: number,
  rules: BadgeRules,
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = readBadgeRules({
    badge_new_label: rules.newLabel,
    badge_new_days: rules.newDays,
    badge_new_tone: rules.newTone,
    badge_best_label: rules.bestSellerLabel,
    badge_best_tone: rules.bestSellerTone,
    badge_low_label: rules.lowStockLabel,
    badge_low_at: rules.lowStockAt,
    badge_low_tone: rules.lowStockTone,
  })

  /*
   * INSERT ... ON DUPLICATE, not UPDATE.
   *
   * A shop that has never opened the listings screen has no default row at
   * all, and an UPDATE against nothing succeeds while changing nothing — the
   * failure that looks like the form not working. The sentinel makes the
   * duplicate key real; see 186 on why it cannot be NULL.
   */
  await siteExecute(
    siteId,
    `INSERT INTO online_listing_presets
       (department_id, badge_new_label, badge_new_days, badge_new_tone,
        badge_best_label, badge_best_tone, badge_low_label, badge_low_at,
        badge_low_tone, updated_at, updated_by)
     VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       badge_new_label = VALUES(badge_new_label),
       badge_new_days = VALUES(badge_new_days),
       badge_new_tone = VALUES(badge_new_tone),
       badge_best_label = VALUES(badge_best_label),
       badge_best_tone = VALUES(badge_best_tone),
       badge_low_label = VALUES(badge_low_label),
       badge_low_at = VALUES(badge_low_at),
       badge_low_tone = VALUES(badge_low_tone),
       updated_at = NOW(),
       updated_by = VALUES(updated_by)`,
    [
      clean.newLabel,
      clean.newDays,
      clean.newTone,
      clean.bestSellerLabel,
      clean.bestSellerTone,
      clean.lowStockLabel,
      clean.lowStockAt,
      clean.lowStockTone,
      actor.slice(0, 120),
    ],
  )
  return { ok: true }
}

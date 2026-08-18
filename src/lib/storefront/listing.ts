/**
 * How a listing looks: columns, what a tile shows, which facets, the order.
 *
 * ── CLIENT-SAFE, LIKE THE REST OF THE STOREFRONT MODEL ───────────────────
 *
 * No `server-only` and no database import. The admin screen previews a tile
 * with these settings and the shop renders one, and both must agree — which is
 * only guaranteed if they run the same code rather than two implementations of
 * the same list.
 *
 * ── THE VOCABULARY IS THE VALIDATION ─────────────────────────────────────
 *
 * `card_fields` and `facets` are stored as CSV, and everything not in the
 * fixed lists below is dropped on read. A value from a build that offered a
 * field this one does not becomes "not shown" rather than reaching a renderer
 * that has no case for it.
 */

import { CATALOGUE_SORTS, type CatalogueSort } from './sorts'

/* ── What a product tile may show ─────────────────────────────────────────── */

/**
 * The parts of a tile an owner can switch off.
 *
 * The tile draws nine things by default and is 160px wide on a phone. Nine is
 * right for a hardware shop where the code, the brand and the stock figure are
 * how somebody identifies a part, and wrong for a boutique where the photograph
 * is the product and everything else is clutter over it.
 *
 * The TITLE and the PICTURE are not in this list. A tile with neither is not a
 * tile, and offering the switch would be offering a way to render nothing.
 */
export const CARD_FIELDS = [
  /** The department chip over the picture. */
  'department',
  /** "Save 20%" when a special is running. */
  'saving',
  /** "Only 3 left" / "Sold out" — also gated by the shop's showStock setting. */
  'stock',
  /** The brand line above the name. */
  'brand',
  /** "4 options" under the name, for a variant group. */
  'variants',
  /** The star rating, when there are approved reviews. */
  'rating',
  /** The price itself. */
  'price',
  /** The Add button, or "Choose" for a group. */
  'add',
] as const
export type CardField = (typeof CARD_FIELDS)[number]

/** The facets a listing may offer. */
export const LISTING_FACETS = ['brand', 'price', 'special', 'stock'] as const
export type ListingFacet = (typeof LISTING_FACETS)[number]

/** Grid or a row per product. Grid needs photographs; see `asGrid`. */
export const LISTING_LAYOUTS = ['grid', 'list'] as const
export type ListingLayout = (typeof LISTING_LAYOUTS)[number]

/**
 * Products per page.
 *
 * A short list, because this is a number nobody should be typing: 7 per page
 * leaves a ragged last row at every column count, and 200 is a page nobody
 * finishes loading on a phone. Each of these divides evenly at 2, 3 and 4
 * columns.
 */
export const PER_PAGE_CHOICES = [12, 24, 36, 48] as const

/* ── One listing's settings ───────────────────────────────────────────────── */

export type ListingPreset = {
  /** Null for the shop's default row. */
  departmentId: number | null
  columnsDesktop: number
  columnsPhone: number
  perPage: number
  defaultSort: CatalogueSort
  layout: ListingLayout
  cardFields: CardField[]
  facets: ListingFacet[]
}

/** What a shop gets before anybody changes anything: today's behaviour. */
export const DEFAULT_LISTING: ListingPreset = {
  departmentId: null,
  columnsDesktop: 4,
  columnsPhone: 2,
  perPage: 24,
  defaultSort: 'name',
  layout: 'grid',
  cardFields: [...CARD_FIELDS],
  facets: ['brand', 'price'],
}

/* ── Reading one back ─────────────────────────────────────────────────────── */

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * A CSV column into a validated list, in the order the vocabulary declares.
 *
 * Order comes from the VOCABULARY and not from the stored string, so a tile
 * cannot end up drawing its price above its name because of the sequence
 * somebody's checkboxes happened to be saved in. What is stored is a set; the
 * renderer needs an order, and this file is where that order is stated.
 */
function readSet<T extends string>(raw: unknown, vocabulary: readonly T[]): T[] {
  const stored = new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return vocabulary.filter((v) => stored.has(v))
}

/** Turn a validated list back into the column. */
export function writeSet(values: readonly string[]): string {
  return values.join(',')
}

/**
 * Coerce a stored row into settings a renderer can trust.
 *
 * Fails safe in one direction: anything unrecognised becomes the default, which
 * is the listing exactly as it renders today. Same stance as
 * `readDesignTokens`, and for the same reason — this is read from columns an
 * admin form wrote.
 */
export function readListingPreset(row: Record<string, unknown> | null | undefined): ListingPreset {
  if (!row) return { ...DEFAULT_LISTING, cardFields: [...DEFAULT_LISTING.cardFields] }

  const departmentId = Number(row.department_id)
  const sort = String(row.default_sort ?? '')
  const layout = String(row.layout ?? '')

  /*
   * An empty stored set is a real answer, not a missing one.
   *
   * An owner who switched every facet off meant it, so `readSet` returning []
   * must survive rather than falling back to the default pair — otherwise the
   * one thing they explicitly asked for is the one thing that cannot be saved.
   * The COLUMN is NOT NULL with a default, so "never set" and "set to nothing"
   * are already distinguishable at the row level.
   */
  return {
    // 0 is the stored sentinel for the shop default — see SHOP_DEFAULT in
    // listingPresets.ts. It reads back as null, which is what the model calls it.
    departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : null,
    columnsDesktop: clamp(row.columns_desktop, 2, 6, DEFAULT_LISTING.columnsDesktop),
    columnsPhone: clamp(row.columns_phone, 1, 2, DEFAULT_LISTING.columnsPhone),
    perPage: (PER_PAGE_CHOICES as readonly number[]).includes(Number(row.per_page))
      ? Number(row.per_page)
      : DEFAULT_LISTING.perPage,
    defaultSort: (CATALOGUE_SORTS as readonly string[]).includes(sort)
      ? (sort as CatalogueSort)
      : DEFAULT_LISTING.defaultSort,
    layout: (LISTING_LAYOUTS as readonly string[]).includes(layout)
      ? (layout as ListingLayout)
      : DEFAULT_LISTING.layout,
    cardFields: readSet(row.card_fields, CARD_FIELDS),
    facets: readSet(row.facets, LISTING_FACETS),
  }
}

/**
 * The grid's column classes, written out rather than built.
 *
 * ── WHY THIS IS A LOOKUP AND NOT A TEMPLATE ──────────────────────────────
 *
 * Tailwind extracts class names statically, so `grid-cols-${n}` is a class the
 * stylesheet does not contain: the grid silently collapses to one column and
 * nothing errors. The renderer maps a number to a string it wrote itself — the
 * rule `RICH_COLOURS` and `PRODUCT_GRID_CLASS` already follow.
 *
 * The intermediate breakpoints are derived rather than configurable: an owner
 * chooses what a phone shows and what a desktop shows, and the sizes between
 * are ours to interpolate. Asking for four numbers would be asking somebody to
 * design a responsive grid.
 */
export function gridClass(columnsPhone: number, columnsDesktop: number): string {
  const phone = columnsPhone <= 1 ? 'grid-cols-1' : 'grid-cols-2'
  const desktop: Record<number, string> = {
    2: '@sm:grid-cols-2 @lg:grid-cols-2 @xl:grid-cols-2',
    3: '@sm:grid-cols-2 @lg:grid-cols-3 @xl:grid-cols-3',
    4: '@sm:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-4',
    5: '@sm:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5',
    6: '@sm:grid-cols-4 @lg:grid-cols-5 @xl:grid-cols-6',
  }
  return `${phone} ${desktop[columnsDesktop] ?? desktop[4]}`
}

/* ── Badges ───────────────────────────────────────────────────────────────── */

/**
 * The tones a badge may wear.
 *
 * The kit's own, so a badge follows the shop's palette and a theme change
 * carries it. An owner picks a MEANING — new, good, careful — and the theme
 * decides what that looks like, which is the same reasoning rich-text colours
 * follow.
 */
export const BADGE_TONES = ['brand', 'success', 'warning', 'danger', 'neutral'] as const
export type BadgeTone = (typeof BADGE_TONES)[number]

export function safeBadgeTone(value: unknown): BadgeTone {
  const raw = String(value ?? '')
  return (BADGE_TONES as readonly string[]).includes(raw) ? (raw as BadgeTone) : 'brand'
}

export type ProductBadge = { label: string; tone: BadgeTone }

/**
 * How many badges one tile may wear.
 *
 * Two. A tile already carries a price, a name and often a saving; a third
 * badge is the one nobody reads, and it arrives by accident — a product that
 * is new AND low on stock AND hand-labelled is not unusual.
 */
export const MAX_TILE_BADGES = 2

/**
 * What a product's badges are.
 *
 * ── ONE FUNCTION, TWO CALLERS ────────────────────────────────────────────
 *
 * The shop draws these and the builder's canvas draws them too. Stating "new
 * means added in the last N days" twice is how the preview ends up promising a
 * badge the shop does not print.
 *
 * A pure function over values the caller already has, deliberately: it takes no
 * database handle, so it can run inside a client component and inside a test
 * without either needing a connection.
 */
export function badgesFor(
  product: { onlineBadge?: string | null; onlineBadgeTone?: string | null; addedDaysAgo?: number | null; stockOnHand?: number | null; isBestSeller?: boolean },
  rules: BadgeRules,
): ProductBadge[] {
  const out: ProductBadge[] = []

  /*
   * Rules first, then the hand-written one.
   *
   * A rule badge is about the moment — new, selling fast, nearly gone — and it
   * is the one a shopper acts on. A hand-written badge is about what the
   * product IS, which is true whether or not they see it on this tile.
   */
  if (rules.newLabel && (product.addedDaysAgo ?? Infinity) <= rules.newDays) {
    out.push({ label: rules.newLabel, tone: rules.newTone })
  }
  if (rules.bestSellerLabel && product.isBestSeller) {
    out.push({ label: rules.bestSellerLabel, tone: rules.bestSellerTone })
  }
  if (
    rules.lowStockLabel &&
    product.stockOnHand != null &&
    product.stockOnHand > 0 &&
    product.stockOnHand <= rules.lowStockAt
  ) {
    out.push({ label: rules.lowStockLabel, tone: rules.lowStockTone })
  }

  const manual = String(product.onlineBadge ?? '').trim()
  if (manual) out.push({ label: manual.slice(0, 24), tone: safeBadgeTone(product.onlineBadgeTone) })

  return out.slice(0, MAX_TILE_BADGES)
}

/** The shop's badge rules. Empty label means the rule is off. */
export type BadgeRules = {
  newLabel: string
  newDays: number
  newTone: BadgeTone
  bestSellerLabel: string
  bestSellerTone: BadgeTone
  lowStockLabel: string
  lowStockAt: number
  lowStockTone: BadgeTone
}

/** Every rule off. A shop that has set nothing gets no rule badges. */
export const DEFAULT_BADGE_RULES: BadgeRules = {
  newLabel: '',
  newDays: 30,
  newTone: 'brand',
  bestSellerLabel: '',
  bestSellerTone: 'success',
  lowStockLabel: '',
  lowStockAt: 3,
  lowStockTone: 'warning',
}

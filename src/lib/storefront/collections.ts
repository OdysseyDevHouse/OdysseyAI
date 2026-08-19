/**
 * Collections: a shop's own way of grouping what it sells.
 *
 * ── WHY THIS IS NOT A DEPARTMENT ─────────────────────────────────────────
 *
 * Departments are the inventory tree — shared with the till, the stockroom and
 * every report — and they answer "where does this live". "Gifts under R300",
 * "Summer" and "New this week" answer a different question, cut across aisles,
 * and come and go. Putting them in the department tree would corrupt the one
 * structure the rest of the business counts on, and it is why a merchant could
 * previously not say what a group of products IS.
 *
 * ── CLIENT-SAFE, BECAUSE THE EDITOR PREVIEWS WHAT THE SHOP RENDERS ───────
 *
 * The admin screen describes a rule in words and the shop resolves it; if
 * those two lists ever parted company, a merchant would be shown a collection
 * that is not the one their shoppers get.
 */

/**
 * How a collection is filled.
 *
 * ── THE SAME WORDS AS A PRODUCT ROW, DELIBERATELY ────────────────────────
 *
 * `PRODUCT_SOURCES` in `storefrontModel` already asks a merchant this exact
 * question for a row on a built page, and the answer means the same thing
 * here. Two vocabularies for one idea would be two things to learn and two
 * places to disagree.
 */
export const COLLECTION_RULES = [
  /** Hand-picked, in the order somebody chose. The order IS the decision. */
  'manual',
  /** Everything currently on special. Maintains itself as specials come and go. */
  'special',
  /** The products added most recently. */
  'newest',
  /** What has sold most over the last 90 days. */
  'popular',
  /** Everything of one brand. */
  'brand',
  /** Everything in one department — for a collection that IS an aisle, renamed. */
  'department',
] as const
export type CollectionRule = (typeof COLLECTION_RULES)[number]

/** Which rules need a value alongside them, and what kind of value. */
export const RULES_NEEDING_VALUE: readonly CollectionRule[] = ['brand', 'department']

export function safeCollectionRule(value: unknown): CollectionRule {
  const raw = String(value ?? '')
  return (COLLECTION_RULES as readonly string[]).includes(raw)
    ? (raw as CollectionRule)
    : 'manual'
}

/** What each rule does, in the merchant's own terms. */
export const RULE_LABEL: Record<CollectionRule, string> = {
  manual: 'Products I pick',
  special: 'Whatever is on special',
  newest: 'Newest products',
  popular: 'Best sellers',
  brand: 'Everything of one brand',
  department: 'Everything in a department',
}

export const RULE_HINT: Record<CollectionRule, string> = {
  manual: 'You choose them, in the order you want them shown.',
  special: 'Fills itself from your live specials, and empties when they end.',
  newest: 'The products you added most recently.',
  popular: 'What has sold most over the last 90 days.',
  brand: 'Everything published from one brand.',
  department: 'Everything published in one department, under a name you choose.',
}

export type Collection = {
  id: number
  slug: string
  title: string
  description: string
  imageId: number | null
  isPublished: boolean
  sortOrder: number
  rule: CollectionRule
  ruleValue: string
  seoTitle: string
  seoDescription: string
}

/** How many collections one shop may have, and how many picks one may hold. */
export const MAX_COLLECTIONS = 40
export const MAX_COLLECTION_PICKS = 200

/**
 * A readable address, derived from a title.
 *
 * Lower case, words joined by hyphens, everything else dropped. Not because a
 * URL cannot carry more, but because this is meant to be read aloud and typed
 * from a poster — and a slug with an apostrophe in it is one somebody gets
 * wrong.
 */
export function slugify(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Strip accents rather than encoding them: "Café" becomes "cafe", which is
    // what somebody types.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Is this a slug we are willing to store?
 *
 * Empty is not: a collection with no address cannot be reached, and generating
 * one silently would give two collections the same address the moment two
 * titles reduced to nothing.
 */
export function safeCollectionSlug(value: unknown): string {
  return slugify(String(value ?? ''))
}

/**
 * How a listing is ordered — the vocabulary, not the SQL.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
 *
 * These names are needed in three places: the query that orders by them, the
 * chips a shopper picks from, and the admin screen that chooses a department's
 * default. The first is server-only and the other two are components, so the
 * list cannot live beside the query — `storefront.ts` opens with
 * `import 'server-only'`, and pulling it into a client bundle is exactly the
 * mistake that file exists to prevent.
 *
 * The SQL each one maps to stays server-side, in `storefront.ts`. That split is
 * the point: a name is safe to ship to a browser, an ORDER BY fragment is not
 * something a browser should ever be able to name.
 */

/**
 * The orders a listing may take.
 *
 * A fixed set mapped through a literal record on the server, never a string
 * reaching a query: the value arrives from a query parameter and decides an
 * ORDER BY, which is the classic place an injection gets in. A closed
 * vocabulary makes one unrepresentable rather than something to escape.
 */
export const CATALOGUE_SORTS = ['name', 'priceAsc', 'priceDesc', 'newest'] as const
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number]

/** Anything else — a stale link, a typo, a probe — reads as the default. */
export function safeSort(value: unknown): CatalogueSort {
  const raw = String(value ?? '')
  return (CATALOGUE_SORTS as readonly string[]).includes(raw) ? (raw as CatalogueSort) : 'name'
}

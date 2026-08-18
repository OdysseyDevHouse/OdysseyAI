import Link from 'next/link'
import { CATALOGUE_SORTS, type CatalogueSort } from '@/lib/site/storefront'

/**
 * How a shopper reorders a department.
 *
 * ── LINKS, LIKE THE FACETS BESIDE IT ─────────────────────────────────────
 *
 * A `<select>` would need JavaScript to navigate, would not work before
 * hydration, and would leave the chosen order out of the URL — so it could not
 * be shared or bookmarked, and the back button would forget it. `FacetBar`
 * already made this decision for brands and price bands; a sort that behaved
 * differently from the chips it sits next to would be the odd one out for no
 * reason.
 *
 * ── CHANGING THE ORDER RETURNS TO PAGE ONE ───────────────────────────────
 *
 * Deliberately, and it is the detail that is easy to miss: page 4 of "cheapest
 * first" and page 4 of "newest" have nothing to do with each other, so
 * carrying the number across drops a shopper into the middle of a list they
 * have never seen. Every href here omits `page`, which is how the pager reads
 * "page 1".
 */

/** The words a shopper reads. The keys are ours; these are theirs. */
const SORT_LABEL: Record<CatalogueSort, string> = {
  name: 'A to Z',
  priceAsc: 'Cheapest first',
  priceDesc: 'Dearest first',
  newest: 'Newest first',
}

export default function SortBar({
  basePath,
  active,
  /** Everything else the URL carries, so reordering keeps the filters. */
  params,
}: {
  basePath: string
  active: CatalogueSort
  params: Record<string, string | undefined>
}) {
  const href = (sort: CatalogueSort) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value) next.set(key, value)
    }
    // 'name' is the default, so it carries no parameter — the plain department
    // URL and ?sort=name are then one address rather than two that render
    // identically, which is a duplicate a search engine has to be told about.
    if (sort === 'name') next.delete('sort')
    else next.set('sort', sort)
    const qs = next.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  return (
    <nav className="mt-3 flex flex-wrap items-center gap-2" aria-label="Order">
      <span className="text-xs font-medium text-muted">Order</span>
      {CATALOGUE_SORTS.map((sort) =>
        sort === active ? (
          <span
            key={sort}
            aria-current="true"
            className="rounded-pill bg-brand-soft px-3 py-1 text-xs font-medium text-brand-ink"
          >
            {SORT_LABEL[sort]}
          </span>
        ) : (
          <Link
            key={sort}
            href={href(sort)}
            className="rounded-pill border border-border px-3 py-1 text-xs text-ink transition hover:border-brand hover:text-brand"
          >
            {SORT_LABEL[sort]}
          </Link>
        ),
      )}
    </nav>
  )
}

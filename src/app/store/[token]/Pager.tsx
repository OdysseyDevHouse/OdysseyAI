import Link from 'next/link'

/**
 * Numbered paging for a listing.
 *
 * ── LINKS, NOT STATE ─────────────────────────────────────────────────────
 *
 * Every page is a real URL, so it can be shared, bookmarked, opened in a new
 * tab and crawled — the same reasoning `FacetBar` gives for its own chips.
 * "Load more" is the alternative and it fails all four, plus it makes the
 * footer unreachable on a long department, which is where the delivery and
 * returns links live.
 *
 * ── AND WHY IT SHOWS THE TOTAL ───────────────────────────────────────────
 *
 * Without one a pager can only offer "next" until a page comes back short,
 * which is how a shopper ends up on an empty page concluding the shop is
 * broken. Knowing there are 380 also tells them whether to narrow the filter
 * or start clicking — a decision they cannot make from a bare arrow.
 */
export default function Pager({
  page,
  perPage,
  total,
  /** The current URL's other parameters, so paging keeps the filters. */
  params,
  basePath,
}: {
  page: number
  perPage: number
  total: number
  params: Record<string, string | undefined>
  basePath: string
}) {
  const pages = Math.max(1, Math.ceil(total / perPage))
  if (pages <= 1) return null

  const href = (n: number) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value) next.set(key, value)
    }
    // Page 1 carries no parameter, so the department's own URL and its first
    // page are the same address rather than two that render identically —
    // which is a duplicate a search engine would have to be told about.
    if (n > 1) next.set('page', String(n))
    else next.delete('page')
    const qs = next.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  const first = (page - 1) * perPage + 1
  const last = Math.min(page * perPage, total)

  return (
    <nav className="mt-8 flex flex-col items-center gap-3" aria-label="Pages">
      <div className="flex items-center gap-1">
        {/*
          Previous and next are rendered as spans when they would go nowhere,
          not as disabled links. A link that does not navigate is a promise the
          page breaks; a span is simply not a control.
        */}
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            rel="prev"
            className="rounded-control border border-border px-3 py-2 text-sm text-ink transition hover:border-brand hover:text-brand"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-control border border-border px-3 py-2 text-sm text-faint">
            Previous
          </span>
        )}

        {pageNumbers(page, pages).map((n, i) =>
          n === null ? (
            // A gap, not a control: on a 40-page department the numbers between
            // 3 and 38 are noise, and a shopper reaching for one of them wants
            // the filter instead.
            <span key={`gap-${i}`} className="px-1 text-sm text-faint">
              …
            </span>
          ) : n === page ? (
            <span
              key={n}
              aria-current="page"
              className="rounded-control bg-brand px-3 py-2 text-sm font-medium text-white"
            >
              {n}
            </span>
          ) : (
            <Link
              key={n}
              href={href(n)}
              className="rounded-control border border-border px-3 py-2 text-sm text-ink transition hover:border-brand hover:text-brand"
            >
              {n}
            </Link>
          ),
        )}

        {page < pages ? (
          <Link
            href={href(page + 1)}
            rel="next"
            className="rounded-control border border-border px-3 py-2 text-sm text-ink transition hover:border-brand hover:text-brand"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-control border border-border px-3 py-2 text-sm text-faint">
            Next
          </span>
        )}
      </div>

      <p className="text-xs text-muted">
        Showing {first}–{last} of {total}
      </p>
    </nav>
  )
}

/**
 * Which page numbers to draw: the ends, and a window around where we are.
 *
 * `null` is a gap. Forty numbered links is not navigation — it is a wall a
 * shopper scrolls past — so the ends stay reachable (page 1 to start over, the
 * last to see how deep this goes) and the rest is the neighbourhood of the
 * current page, which is the only part anybody clicks.
 */
function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)

  const out: (number | null)[] = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(pages - 1, page + 1)

  if (from > 2) out.push(null)
  for (let n = from; n <= to; n++) out.push(n)
  if (to < pages - 1) out.push(null)

  out.push(pages)
  return out
}

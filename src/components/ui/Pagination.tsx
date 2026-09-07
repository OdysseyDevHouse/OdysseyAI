import Link from 'next/link'
import { ChevronLeft, ChevronRight, PageFirst, PageLast } from './icons'
import { buttonClass } from './styles'

/**
 * Pager for a list.
 *
 * ── TWO WAYS TO MOVE, ONE PAGER ──────────────────────────────────────────
 *
 * `hrefFor` renders LINKS, which is what a server-rendered list wants: the page
 * lives in the URL, so a server component can render this directly and the
 * browser's back button walks the pages. Keep the rest of the query string
 * attached by building the href with `hrefBuilder` from lib/searchParams, so a
 * page change can never drop a filter.
 *
 * `onPage` renders BUTTONS, for a list whose page is React state rather than a
 * URL — the product search dialog, where the URL belongs to the screen behind
 * it and rewriting it would put a half-captured document one Back button away
 * from being lost. Same markup, same skin, same disabled rules; only what a
 * step does differs.
 *
 * Pass exactly one. A pager wired to both would have two ideas about where the
 * next page comes from, and a screen that navigates AND sets state ends up
 * rendering page 2 of one list and page 3 of another.
 *
 * Renders nothing at all for a single page. A pager under a five-row table is
 * chrome that says "there is more" when there is not.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  hrefFor,
  onPage,
  className = '',
}: {
  page: number
  pageCount: number
  /** Row count across every page, for the "showing x–y of z" line. */
  total?: number
  pageSize?: number
  /** Server-rendered list: where each page lives. Pass this or `onPage`. */
  hrefFor?: (page: number) => string
  /** Client-held page: what to do with the page stepped to. Pass this or `hrefFor`. */
  onPage?: (page: number) => void
  className?: string
}) {
  if (pageCount <= 1) return null

  const first = page <= 1
  const last = page >= pageCount

  const from = pageSize ? (page - 1) * pageSize + 1 : null
  const to = pageSize && total !== undefined ? Math.min(page * pageSize, total) : null

  return (
    <nav
      aria-label="Pagination"
      className={`flex items-center justify-between gap-4 border-t border-border px-4 py-3 ${className}`}
    >
      <p className="text-[13px] text-muted">
        {from !== null && to !== null && total !== undefined ? (
          <>
            Showing <span className="numeric text-ink-2">{from}</span>–
            <span className="numeric text-ink-2">{to}</span> of{' '}
            <span className="numeric text-ink-2">{total}</span>
          </>
        ) : (
          <>
            Page <span className="numeric text-ink-2">{page}</span> of{' '}
            <span className="numeric text-ink-2">{pageCount}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-1.5">
        <PageStep to={1} hrefFor={hrefFor} onPage={onPage} disabled={first} label="First page">
          <PageFirst size={16} />
        </PageStep>
        <PageStep
          to={page - 1}
          hrefFor={hrefFor}
          onPage={onPage}
          disabled={first}
          label="Previous page"
        >
          <ChevronLeft size={16} />
        </PageStep>
        <span className="px-2 text-[13px] text-muted">
          <span className="numeric text-ink-2">{page}</span> / {pageCount}
        </span>
        <PageStep
          to={page + 1}
          hrefFor={hrefFor}
          onPage={onPage}
          disabled={last}
          label="Next page"
        >
          <ChevronRight size={16} />
        </PageStep>
        <PageStep
          to={pageCount}
          hrefFor={hrefFor}
          onPage={onPage}
          disabled={last}
          label="Last page"
        >
          <PageLast size={16} />
        </PageStep>
      </div>
    </nav>
  )
}

/**
 * One pager control — a link when the page lives in the URL, a button when it
 * lives in React state.
 *
 * A disabled step renders as a <span> in BOTH modes, not a greyed <a> or a
 * disabled <button>: there is no such thing as a disabled link, and a control
 * pointing at the page you are already on is a trap for anyone tabbing through.
 * The two modes therefore have exactly one shape between them when they are at
 * the end of the list, which is what keeps the pager from looking like two
 * different components on two different screens.
 */
function PageStep({
  to,
  hrefFor,
  onPage,
  disabled,
  label,
  children,
}: {
  to: number
  hrefFor?: (page: number) => string
  onPage?: (page: number) => void
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  const skin = buttonClass({ variant: 'ghost', size: 'sm', iconOnly: true })

  if (disabled) {
    return (
      <span aria-hidden className={`${skin} cursor-not-allowed text-faint`}>
        {children}
      </span>
    )
  }

  if (hrefFor) {
    return (
      <Link href={hrefFor(to)} aria-label={label} className={skin}>
        {children}
      </Link>
    )
  }

  return (
    <button type="button" aria-label={label} className={skin} onClick={() => onPage?.(to)}>
      {children}
    </button>
  )
}

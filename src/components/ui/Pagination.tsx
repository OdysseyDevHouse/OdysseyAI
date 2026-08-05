import Link from 'next/link'
import { ChevronLeft, ChevronRight, PageFirst, PageLast } from './icons'
import { buttonClass } from './styles'

/**
 * Pager for a server-rendered list.
 *
 * Links, not buttons, and no client state: the page lives in the URL, so a
 * server component can render this directly and the browser's back button
 * walks the pages. `hrefFor` is what keeps the rest of the query string —
 * search, filters, sort — attached; build it with `hrefBuilder` from
 * lib/searchParams so a page change can never drop a filter.
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
  className = '',
}: {
  page: number
  pageCount: number
  /** Row count across every page, for the "showing x–y of z" line. */
  total?: number
  pageSize?: number
  hrefFor: (page: number) => string
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
        <PageLink href={hrefFor(1)} disabled={first} label="First page">
          <PageFirst size={16} />
        </PageLink>
        <PageLink href={hrefFor(page - 1)} disabled={first} label="Previous page">
          <ChevronLeft size={16} />
        </PageLink>
        <span className="px-2 text-[13px] text-muted">
          <span className="numeric text-ink-2">{page}</span> / {pageCount}
        </span>
        <PageLink href={hrefFor(page + 1)} disabled={last} label="Next page">
          <ChevronRight size={16} />
        </PageLink>
        <PageLink href={hrefFor(pageCount)} disabled={last} label="Last page">
          <PageLast size={16} />
        </PageLink>
      </div>
    </nav>
  )
}

/**
 * One pager control.
 *
 * A disabled step renders as a <span>, not a greyed <a>: there is no such thing
 * as a disabled link, and a link to the page you are already on is a trap for
 * anyone tabbing through.
 */
function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string
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

  return (
    <Link href={href} aria-label={label} className={skin}>
      {children}
    </Link>
  )
}

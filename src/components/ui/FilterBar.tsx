import { Children, type ReactNode } from 'react'
import Link from 'next/link'
import { Close, Filter } from './icons'

/**
 * The strip of applied filters above a list.
 *
 * Every filter is a link, because filter state lives in the URL — that is what
 * makes a filtered list linkable, reloadable and server-rendered. Build the
 * hrefs with `hrefBuilder` from lib/searchParams: a chip that clears one filter
 * must preserve the others, and hand-written query strings are exactly how that
 * gets broken.
 *
 * Renders nothing when no filters are applied, so a screen can drop it in
 * unconditionally.
 */
export function FilterBar({
  children,
  clearHref,
  className = '',
}: {
  /** <FilterChip>s. Falsy children are fine — an unset filter renders nothing. */
  children: ReactNode
  /** Href that clears every filter. Omit to leave out the "Clear all" link. */
  clearHref?: string
  className?: string
}) {
  const chips = Children.toArray(children).filter(Boolean)
  if (chips.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-2 px-6 pb-3 ${className}`}>
      <Filter size={14} className="text-faint" aria-hidden />
      {chips}
      {clearHref && chips.length > 1 && (
        <Link href={clearHref} className="ml-1 text-xs text-muted transition hover:text-ink">
          Clear all
        </Link>
      )}
    </div>
  )
}

/**
 * One applied filter, with the label spelled out.
 *
 * "Department: Fresh Produce", not a bare "Fresh Produce" — a chip has to say
 * which field it constrains, or a screen with four filters becomes a row of
 * values nobody can map back to a column.
 */
export function FilterChip({
  label,
  value,
  clearHref,
}: {
  label: string
  value: string
  /** Omit for a filter that cannot be cleared on its own, e.g. a locked scope. */
  clearHref?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-soft py-1 pr-1 pl-2.5 text-xs text-brand">
      <span>
        <span className="opacity-70">{label}:</span> {value}
      </span>
      {clearHref && (
        <Link
          href={clearHref}
          aria-label={`Clear ${label.toLowerCase()} filter`}
          className="rounded-pill p-0.5 transition hover:bg-brand/15"
        >
          <Close size={12} />
        </Link>
      )}
    </span>
  )
}

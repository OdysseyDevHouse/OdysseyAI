'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Search } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * The bar that sits above a list: filters and search on the left, actions on
 * the right. Use TableToolbar rather than hand-rolling a flex row, so every
 * list screen has the same rhythm and control heights.
 */
export function TableToolbar({
  children,
  actions,
  className = '',
}: {
  /** Left side — segmented control, search, filter selects. */
  children?: ReactNode
  /** Right side — Export, New, and friends. */
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  /** Optional count pill, e.g. All 162. */
  count?: number
}

/**
 * SegmentedControl — switches which slice of a list is shown (the GRV
 * All / Orders / GRVs filter). For mutually exclusive *views* of the same data;
 * if the choices navigate somewhere else, use Tabs instead.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  className?: string
  'aria-label'?: string
}) {
  return (
    <SegmentedBar className={className} ariaLabel={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={segmentClass(option.value === value)}
        >
          <SegmentLabel option={option} active={option.value === value} />
        </button>
      ))}
    </SegmentedBar>
  )
}

/**
 * Same control, but each segment is a route — for list filters that live in the
 * URL, which is most of them on the document screens.
 *
 * Each option carries its own `href` rather than the bar taking an `hrefFor`
 * function, for the same reason LinkTabs does: this file is `'use client'`, and
 * a Server Component cannot pass a FUNCTION across the boundary. The list pages
 * that need this are server-rendered, so a callback-only control would be
 * unusable there. Strings cross fine.
 */
export function LinkSegmentedControl<T extends string>({
  options,
  value,
  className = '',
  'aria-label': ariaLabel,
}: {
  options: readonly (SegmentedOption<T> & { href: string })[]
  value: T
  className?: string
  'aria-label'?: string
}) {
  return (
    <SegmentedBar className={className} ariaLabel={ariaLabel}>
      {options.map((option) => (
        <Link
          key={option.value}
          href={option.href}
          aria-current={option.value === value ? 'page' : undefined}
          className={segmentClass(option.value === value)}
        >
          <SegmentLabel option={option} active={option.value === value} />
        </Link>
      ))}
    </SegmentedBar>
  )
}

function SegmentedBar({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode
  className: string
  ariaLabel?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 rounded-control border border-border bg-surface p-1 ${className}`}
    >
      {children}
    </div>
  )
}

function segmentClass(active: boolean) {
  return `inline-flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-sm font-medium whitespace-nowrap transition ${
    active ? 'bg-brand text-white' : 'text-muted hover:bg-surface-2 hover:text-ink'
  }`
}

function SegmentLabel<T extends string>({
  option,
  active,
}: {
  option: SegmentedOption<T>
  active: boolean
}) {
  return (
    <>
      {option.label}
      {option.count !== undefined && (
        <span
          className={`numeric rounded-pill px-1.5 text-xs font-medium ${
            active ? 'bg-white/20 text-white' : 'bg-surface-2 text-muted'
          }`}
        >
          {option.count}
        </span>
      )}
    </>
  )
}

/** The standard list search box — leading icon, control height, brand focus. */
export function ToolbarSearch({
  value,
  onChange,
  placeholder = 'Search...',
  className = 'w-64',
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  className?: string
  'aria-label'?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search
        size={16}
        className="pointer-events-none absolute inset-y-0 left-3 my-auto text-faint"
      />
      <input
        type="search"
        value={value}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${CONTROL_H} pl-9`}
      />
    </div>
  )
}

'use client'

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
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 rounded-control border border-border bg-surface p-1 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-sm font-medium transition ${
              active ? 'bg-brand text-white' : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
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
          </button>
        )
      })}
    </div>
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

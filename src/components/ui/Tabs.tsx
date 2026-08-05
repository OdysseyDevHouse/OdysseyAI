'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'

export type TabItem<T extends string> = {
  value: T
  label: string
  /** Optional leading glyph at size 16. Text-only bars are fine too. */
  icon?: ReactNode
  count?: number
}

/**
 * Tabs — the underline tab bar (as on Edit Product). Use it for every tabbed
 * screen so the active-tab treatment stays identical.
 *
 * Tabs switch between *sections of one record*. To filter one list into slices,
 * use SegmentedControl instead.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  items: readonly TabItem<T>[]
  value: T
  onChange: (next: T) => void
  className?: string
  'aria-label'?: string
}) {
  return (
    <TabBar className={className} ariaLabel={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          onClick={() => onChange(item.value)}
          className={tabClass(item.value === value)}
        >
          <TabLabel item={item} />
        </button>
      ))}
    </TabBar>
  )
}

/**
 * Same bar, but each tab is a route. Keeps tab state in the URL.
 *
 * Each item carries its own `href` rather than the bar taking an `hrefFor`
 * function. That is not a style choice: this file is `'use client'`, and a
 * Server Component cannot pass a FUNCTION across the boundary — React refuses
 * it at runtime with "Functions cannot be passed directly to Client
 * Components". Since almost every tabbed screen here is server-rendered, a prop
 * that only works from a client parent is a trap. Strings cross the boundary
 * fine.
 */
export function LinkTabs<T extends string>({
  items,
  value,
  className = '',
  'aria-label': ariaLabel,
}: {
  items: readonly (TabItem<T> & { href: string })[]
  value: T
  className?: string
  'aria-label'?: string
}) {
  return (
    <TabBar className={className} ariaLabel={ariaLabel}>
      {items.map((item) => (
        <Link
          key={item.value}
          href={item.href}
          aria-current={item.value === value ? 'page' : undefined}
          className={tabClass(item.value === value)}
        >
          <TabLabel item={item} />
        </Link>
      ))}
    </TabBar>
  )
}

function TabBar({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode
  className: string
  ariaLabel?: string
}) {
  /* overflow-y-hidden alongside overflow-x-auto on purpose: the tabs use -mb-px
     to sit their underline on this border, which makes the content 1px taller
     than the bar. Without pinning the vertical axis, `overflow-x-auto` implies
     `overflow-y: auto` and the browser shows a stray vertical scrollbar. */
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex items-center gap-6 overflow-x-auto overflow-y-hidden border-b border-border ${className}`}
    >
      {children}
    </div>
  )
}

/* -mb-px pulls the active underline onto the bar's own border so the two read
   as one line rather than a double rule. */
function tabClass(active: boolean) {
  return `-mb-px flex items-center gap-2 border-b-2 px-0.5 pb-2.5 text-sm font-medium whitespace-nowrap transition ${
    active
      ? 'border-brand text-brand'
      : 'border-transparent text-muted hover:border-border-strong hover:text-ink'
  }`
}

function TabLabel<T extends string>({ item }: { item: TabItem<T> }) {
  return (
    <>
      {item.icon}
      {item.label}
      {item.count !== undefined && (
        <span className="numeric rounded-pill bg-surface-2 px-1.5 text-xs text-muted">
          {item.count}
        </span>
      )}
    </>
  )
}

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
 * Tabs — the tab bar (as on Edit Product), an amber rule that wraps whichever
 * tab is open. Use it for every tabbed screen so the active-tab treatment stays
 * identical.
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
  /* `items-stretch`, not `items-center`: every cell — the two fillers included
     — has to reach the full height of the bar, because each one owns the piece
     of rule that crosses it. Centred, the fillers would collapse to nothing and
     the line would exist only under the tabs.

     overflow-y-hidden alongside overflow-x-auto on purpose: without pinning the
     vertical axis, `overflow-x-auto` implies `overflow-y: auto` and the browser
     shows a stray vertical scrollbar for the 1px the borders add. */
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex items-stretch overflow-x-auto overflow-y-hidden ${className}`}
    >
      {/* The rule runs in from the left edge of whatever the bar sits in… */}
      <div className="w-6 shrink-0 border-b border-nav-accent" aria-hidden />
      {children}
      {/* …and out to the right edge. flex-1 so it takes all the slack, which is
          what makes the rule reach the edge at any number of tabs. */}
      <div className="flex-1 border-b border-nav-accent" aria-hidden />
    </div>
  )
}

/* ── THE RULE WRAPS THE OPEN TAB ─────────────────────────────────────────
   One amber rule runs the full width of whatever the bar sits in and routes
   AROUND the open tab: in from the left edge, up its left side, over its top,
   down its right side, and out to the right edge. The open tab is the gap in
   the line. Every other tab has the rule pass UNDER it and nothing over, so the
   only thing drawn above the bar's baseline is the box around where you are.

   This replaced a short amber underline stamped beneath the open tab. Both
   answer "you are here" in the same amber the sidebar marks the open section
   with, so the colour means one thing in both places; the box just says it
   with a shape instead of a mark, and reads at a glance on a bar of six tabs
   where a 60px underline did not.

   The label is `ink` rather than `brand`: on a bar of grey labels the SELECTED
   one should be the most readable thing there, and the brand blue was actually
   a step down from black (3.55:1 against white, versus 17.63). A coloured label
   also reads as a link — the one thing a tab you are already on is not. That
   leaves the rule carrying the selection on its own. Its 2.15:1 against white
   would fail as TEXT and is right for a hairline: it is a graphical marker
   beside a 17.63:1 label, not the thing being read.

   An active tab trades its BOTTOM border for a top and two sides. An inactive
   one still declares `border-t`, in transparent — the border has to occupy its
   1px whether or not it paints, or every label would jump upward the moment its
   tab lost selection. */
function tabClass(active: boolean) {
  return `flex items-center gap-2 border-nav-accent px-4 pt-2 pb-2.5 text-sm font-medium whitespace-nowrap transition ${
    active
      ? 'rounded-t-control border-t border-r border-b-0 border-l text-ink'
      : 'border-t border-t-transparent border-b text-muted hover:text-ink'
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

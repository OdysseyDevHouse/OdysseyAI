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
 * Tabs — the tab bar (as on Edit Product): a quiet baseline the whole width of
 * it, and the open tab underlined in the module's colour. Use it for every
 * tabbed screen so the active-tab treatment stays identical.
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
     shows a stray vertical scrollbar for the 2px the borders add. */
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex items-stretch overflow-x-auto overflow-y-hidden ${className}`}
    >
      {/* The baseline runs in from the left edge of whatever the bar sits in… */}
      <div className="w-6 shrink-0 border-b-2 border-border" aria-hidden />
      {children}
      {/* …and out to the right edge. flex-1 so it takes all the slack, which is
          what makes the line reach the edge at any number of tabs. */}
      <div className="flex-1 border-b-2 border-border" aria-hidden />
    </div>
  )
}

/* ── THE OPEN TAB IS UNDERLINED ──────────────────────────────────────────
   A 2px baseline runs the full width of whatever the bar sits in, in the
   neutral border colour, and the segment under the open tab is the module's.
   So the line is continuous and only its COLOUR moves as you change tabs.

   Every cell carries `border-b-2`, the two fillers included — that is what
   keeps the baseline at one thickness and on one pixel row. Give the open tab a
   thicker border than its neighbours and it hangs a pixel below them, and the
   line you were trying to draw develops a step in it.

   This replaced a rule that ROUTED AROUND the open tab — in from the left, up
   its side, over the top, down the far side and out — which drew the selection
   as a box. The box read well and read as a lot: on a screen that now carries
   the module's colour on the card edge, the medallions and the sidebar, one
   more outlined shape was the loudest thing on it. An underline says the same
   thing in one stroke.

   THE OPEN TAB'S LABEL AND GLYPH take the colour too, which is a reversal
   worth recording. They were `ink` — near-black — on the argument that the
   selected label should be the most readable thing on the bar, and that a
   coloured label reads as a link. That held while the colour was the brand
   blue, which IS the colour of every link in the app. It holds less well now
   the colour is the module's: amber words in Back-office are not a link
   anywhere, and the label is the thing the eye lands on, so it is the thing
   that should say which module you are in.

   `accent-text`, not `accent-rule`. The underline is a graphical marker and
   sits at 2.15:1 — right for a line, and a label at that contrast would be
   unreadable. The text step is the same hue taken to 4.5:1 against both the
   canvas and a card. Two steps of one colour, each at the weight its job
   needs; see MODULE COLOURS in globals.css. */
function tabClass(active: boolean) {
  return `flex items-center gap-2 border-b-2 px-4 pt-2 pb-2.5 text-sm whitespace-nowrap transition ${
    active
      ? 'border-accent-rule font-semibold text-accent-text'
      : 'border-border font-medium text-muted hover:text-ink'
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

'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'

/**
 * The phone's bottom navigation.
 *
 * ── WHY THE BOTTOM, AND WHY IT REPLACES THE HAMBURGER ───────────────────────
 *
 * A drawer behind a menu button costs two taps to reach anything and shows
 * nothing about where you are. On a handset held one-handed the top-left
 * corner is also the furthest point from the thumb, which is why every native
 * app of this shape puts its four or five main destinations along the bottom
 * edge instead. The drawer does not disappear — it moves behind "More", which
 * is the one tab that is allowed to be a menu.
 *
 * ── WHAT BELONGS HERE ───────────────────────────────────────────────────────
 *
 * Destinations, never actions. A tab says where you are as much as where you
 * can go, so a tab that fires something and leaves the bar unchanged reads as
 * a broken tab. Five is the ceiling: at 390px a sixth target falls under 64px
 * wide and the labels start truncating, and a truncated label is worse than no
 * sixth tab.
 *
 * The caller decides which tabs exist, because that answer depends on the
 * user's capabilities and the shop's modules — see PhoneNav, which filters the
 * same NAV the drawer and the sidebar read.
 */

export type TabBarItem = {
  key: string
  label: string
  icon: ReactNode
  /** A destination. Omit for the one tab that opens a menu instead. */
  href?: string
  /** For the menu tab. Ignored when `href` is set. */
  onClick?: () => void
  active?: boolean
  /**
   * A count worth interrupting for — unread notifications, jobs overdue.
   *
   * A dot rather than a number past 9, because three digits on a 20px glyph is
   * illegible at any size a tab bar can spare.
   */
  badge?: number
}

export function TabBar({
  items,
  'aria-label': ariaLabel = 'Main',
}: {
  items: readonly TabBarItem[]
  'aria-label'?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      /* The bar sits ON the safe area rather than above it: the row keeps its
         full height and the inset is added underneath, so on a handset with a
         home indicator the tint runs to the bottom edge of the glass instead
         of leaving a strip of canvas below a floating bar. */
      className="shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex items-stretch">
        {items.map((item) => (
          <li key={item.key} className="flex-1">
            <TabBarButton item={item} />
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * One tab.
 *
 * A `Link` when it goes somewhere and a `button` when it opens the menu — the
 * same geometry either way, so the row reads as five of one thing. Rendering
 * the menu tab as a link to nowhere would hand it a URL the browser would
 * happily open in a new tab.
 */
function TabBarButton({ item }: { item: TabBarItem }) {
  /* Icon and label stack, both taking the tab's colour: an active tab is one
     signal shown twice, not a tinted glyph over grey text. */
  const tone = item.active ? 'text-brand' : 'text-muted'

  const inner = (
    <>
      <span className="relative">
        {item.icon}
        {item.badge !== undefined && item.badge > 0 && (
          <span
            className="absolute -right-1.5 -top-1 min-w-4 rounded-pill bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white"
            aria-hidden="true"
          >
            {item.badge > 9 ? '9+' : item.badge}
          </span>
        )}
      </span>
      {/* 10px, which is below the 14px floor for reading type on purpose: a tab
          label is a caption on a glyph that already carries the meaning, and it
          is read once while learning the app rather than repeatedly. */}
      <span className="text-[10px] font-medium leading-none">{item.label}</span>
    </>
  )

  /* 56px of row before the safe-area inset — a comfortable thumb target across
     the full width of the tab, not just the glyph. */
  const className = `flex h-14 w-full flex-col items-center justify-center gap-1 transition active:bg-surface-2 ${tone}`

  if (item.href) {
    return (
      /* A nav destination that must match its four siblings, one of which is a
         <button>. The kit has no control that is both. */
      <Link
        data-kit-ok
        href={item.href}
        aria-current={item.active ? 'page' : undefined}
        className={className}
      >
        {inner}
      </Link>
    )
  }

  return (
    <button
      type="button"
      onClick={item.onClick}
      aria-expanded={item.active ? true : undefined}
      className={className}
    >
      {inner}
    </button>
  )
}

'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from './icons'

/**
 * A titled panel that folds away.
 *
 * ── WHY THIS AND NOT ExpandingCard ───────────────────────────────────────
 *
 * `ExpandingCard` is the till's basket row: it tints itself brand when open
 * because "open" there means "this is the line I am acting on", and its body is
 * a row of action buttons behind a divider. Both are wrong for a settings
 * panel, where open means merely "I am reading this one" and the body is a
 * form. Reusing it would have meant a card that shouts for attention every time
 * somebody expands a heading.
 *
 * ── WHY A STACK OF THESE RATHER THAN TABS ────────────────────────────────
 *
 * A tall panel of settings has one thing wrong with it and one thing right.
 * Wrong: everything is present at once, so the thing you want is a scroll away
 * behind things you are not using. Right: you can see what exists. Tabs fix the
 * first by destroying the second — a name in a tab strip tells you nothing
 * about what is under it, and the panel loses the ability to show two related
 * groups at once.
 *
 * Folding keeps every heading on screen and lets more than one be open, which
 * is what a builder wants: the section's own settings AND the list of what is
 * on the page, at the same time, without the page presets between them.
 *
 * Controlled, always. The parent decides what is open, because "which panels
 * are open" is something a screen usually wants to persist, restore, or open
 * programmatically when something is selected elsewhere.
 */
export function Accordion({
  title,
  description,
  badge,
  open,
  onToggle,
  children,
  className = '',
}: {
  title: string
  /** A line under the title, in the header. Shown whether open or shut. */
  description?: string
  /** A count or state, at the right of the header beside the chevron. */
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
  className?: string
}) {
  return (
    // `shrink-0` because these are usually stacked in a flex column that
    // scrolls. Without it a column of folded panels gets crushed to fit the
    // container instead of overflowing it — every heading squashed to a few
    // pixels of unreadable text, and nothing to scroll because it all "fits".
    <div
      className={`shrink-0 overflow-hidden rounded-card border border-border bg-surface shadow-card ${className}`}
    >
      {/* The whole header is the target, not just the chevron — a fold whose
          hit area is a 14px arrow is one that gets clicked twice. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{title}</span>
          {description && <span className="block truncate text-sm text-muted">{description}</span>}
        </span>
        {badge}
        {/* Rotated rather than swapped for an up-chevron: the same glyph
            turning is read as one control changing state, where two different
            arrows read as two different buttons. */}
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Unmounted rather than hidden. A shut panel holding a mounted form
          keeps its effects running and its inputs in the tab order, which is
          how a collapsed panel ends up stealing focus. */}
      {open && <div className="border-t border-border px-4 py-4">{children}</div>}
    </div>
  )
}

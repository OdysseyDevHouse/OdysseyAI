'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from './icons'
import type { CategoryTone } from './CategoryTile'

/**
 * The coloured bar down a row's leading edge.
 *
 * Written out in full rather than built as `bg-cat-${tone}` — Tailwind scans source
 * text, so an interpolated class is never emitted and the bar renders invisible.
 */
const EDGE: Record<CategoryTone, string> = {
  indigo: 'bg-cat-indigo',
  violet: 'bg-cat-violet',
  emerald: 'bg-cat-emerald',
  amber: 'bg-cat-amber',
  sky: 'bg-cat-sky',
  rose: 'bg-cat-rose',
  teal: 'bg-cat-teal',
  orange: 'bg-cat-orange',
  slate: 'bg-cat-slate',
}

/**
 * The hairline round a row that has an edge, in the same hue.
 *
 * Held at 30% so it reads as the bar's own outline continuing round the row rather
 * than as a second, competing line: a department at full strength on all four sides
 * is a box shouting for attention, and a rail of twelve of them is twelve boxes all
 * shouting. The bar stays solid because that is the part meant to be found.
 */
const EDGE_BORDER: Record<CategoryTone, string> = {
  indigo: 'border-cat-indigo/30',
  violet: 'border-cat-violet/30',
  emerald: 'border-cat-emerald/30',
  amber: 'border-cat-amber/30',
  sky: 'border-cat-sky/30',
  rose: 'border-cat-rose/30',
  teal: 'border-cat-teal/30',
  orange: 'border-cat-orange/30',
  slate: 'border-cat-slate/30',
}

/**
 * A full-width, touch-sized row that is a button.
 *
 * The kit's `Button` is one line of centred label; this is the other shape a till
 * needs constantly — a leading glyph, a title with a subtitle under it, something
 * optional on the right, and the WHOLE thing tappable. "Attach customer / For
 * account sales", "Table 12 / 4 covers, takeaway", "Saved sale #4 / 3 items,
 * R249.90".
 *
 * It exists because the alternative is a hand-rolled <button> at each call site,
 * which check-ui-kit rightly refuses: three screens each inventing their own
 * padding and border for the same shape is exactly the drift the kit prevents.
 *
 * The hit target is the entire row rather than a chevron on it. A finger reaching
 * for a 20px affordance on a list that can scroll is a mis-tap, and on a till a
 * mis-tap happens with a customer watching.
 */
export function TouchRow({
  icon,
  title,
  subtitle,
  trailing,
  showChevron = true,
  tone = 'default',
  edge,
  disabled = false,
  onClick,
  className = '',
}: {
  /** Usually a CategoryTile or a round tinted glyph. */
  icon?: ReactNode
  title: string
  subtitle?: string
  /** An amount, a badge — anything that belongs on the right. */
  trailing?: ReactNode
  showChevron?: boolean
  /** `active` when the row represents something currently chosen. */
  tone?: 'default' | 'active'
  /**
   * A colour down the leading edge, for a list where every row is a different
   * SUBJECT — the till's department rail.
   *
   * Pass the same tone as the row's `CategoryTile`, so the bar and the disc are
   * one identifier rather than two decorations. It earns its place in a scrolling
   * list a cashier reads by colour: the discs alone are 44px of hue with 200px of
   * white between them, and the eye loses the column. On a list where the rows
   * are all the same kind of thing, leave it off — an edge on every row of a
   * saved-sales list is decoration, and that is what makes colour stop meaning
   * anything elsewhere.
   */
  edge?: CategoryTone
  disabled?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative flex w-full items-center gap-3 overflow-hidden rounded-card border py-3 pr-3 text-left transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 ${
        /* The edge is drawn INSIDE the row, so the content is pushed clear of it
           rather than sitting on top. Without an edge the leading padding is the
           plain p-3 every other row in the app uses. */
        edge ? 'pl-4' : 'pl-3'
      } ${
        /* `active` still wins: which row is CHOSEN has to be legible at a glance, and
           a brand-blue outline says that where a slightly stronger department hue
           would just look like another department. */
        tone === 'active'
          ? 'border-brand/40 bg-brand-soft'
          : edge
            ? `${EDGE_BORDER[edge]} bg-surface hover:border-brand/50`
            : 'border-border bg-surface hover:border-brand/50'
      } ${className}`}
    >
      {/* aria-hidden: the colour repeats what the title already says, and a screen
          reader announcing it would be noise.

          Inset by the border width on three sides rather than pinned to the row's
          outer edge. Flush, the bar paints OVER the left border and the row reads as
          a card with one side missing — the hairline has to close all the way round
          for the colour to look applied to the row rather than leaked out of it. */}
      {edge && (
        <span
          aria-hidden
          className={`absolute inset-y-px left-px w-1.5 rounded-l-[11px] ${EDGE[edge]}`}
        />
      )}

      {icon}

      <span className="min-w-0 flex-1">
        {/* 15px, above the back office's 14px: read at arm's length on a counter
            screen rather than at desk distance. */}
        <span className="block truncate text-[15px] font-semibold text-ink">{title}</span>
        {subtitle && <span className="block truncate text-[13px] text-muted">{subtitle}</span>}
      </span>

      {trailing}
      {showChevron && <ChevronRight size={18} className="shrink-0 text-muted" />}
    </button>
  )
}

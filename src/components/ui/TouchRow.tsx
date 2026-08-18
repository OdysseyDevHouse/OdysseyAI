'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from './icons'
import type { CategoryTone } from './CategoryTile'

/* The edge lives in styles.ts, shared with ProductTile and ActionTile — see the note
   on EDGE_RING for why it is a border rather than a bar drawn on top, and why only
   the leading side is at full strength. */
import { EDGE_RING, EDGE_LEAD } from './styles'

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
  /**
   * `active` when the row represents something currently chosen.
   *
   * `bare` drops the border and the fill and keeps everything else — the
   * geometry, the type scale, the chevron, the whole-row hit target. For a row
   * that is already INSIDE a box somebody else drew: the till's module menu puts
   * one at the head of each module card, and a bordered row inside a bordered
   * card is the double frame that made that panel read as nested rectangles.
   *
   * A tone rather than a class the caller passes, because "no border" written at
   * the call site is two colour classes in one attribute — and which of them
   * wins is decided by stylesheet order, not by which was written last.
   */
  tone?: 'default' | 'active' | 'bare'
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
        /* The bar is the row's own LEFT BORDER, not a rectangle laid over it.
           That is what curves its inner edge: a border follows border-radius on
           both sides, so the colour tapers into the corners exactly as the card
           does, where an absolutely-positioned span can only round the outer two
           and leaves a hard vertical line facing the text.

           border-l-4 against border on the other three — thin, as in the
           reference. Less leading padding to compensate, so the icon sits the
           same distance from the colour as it would from a plain hairline. */
        edge ? 'border-l-4 pl-2.5' : 'pl-3'
      } ${
        /* `active` still wins on the surrounding hairline and the fill: which row is
           CHOSEN has to be legible at a glance, and a brand-blue tint says that where
           a slightly stronger department hue would just look like another department.
           The LEADING edge stays the department's own, so a row does not change
           identity by being selected — hence EDGE_LEAD trailing here too, whose
           border-l-* wins over border-brand/40 by being the more specific side. */
        tone === 'active'
          ? `border-brand/40 bg-brand-soft ${edge ? EDGE_LEAD[edge] : ''}`
          : /* Inside a box the caller already drew — no second frame, and a hover
               that tints rather than outlines, since an outline appearing on
               press is the frame arriving after all. An `edge` still shows: the
               leading colour is identity, not chrome, and is the one part of the
               row worth keeping when the rest of the box goes. */
            tone === 'bare'
            ? `border-transparent bg-transparent hover:bg-surface-2 ${edge ? EDGE_LEAD[edge] : ''}`
            : edge
            ? /* No hover:border-brand here. It would repaint all four sides and take
                 the department's leading edge with it — the row would lose its colour
                 at the moment a finger is on it, which is the moment it most needs to
                 be the one you aimed at. The press animation is the feedback instead. */
              `${EDGE_RING[edge]} ${EDGE_LEAD[edge]} bg-surface`
            : 'border-border bg-surface hover:border-brand/50'
      } ${className}`}
    >
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

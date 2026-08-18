'use client'

import type { ReactNode } from 'react'
import { CategoryTile, type CategoryTone } from './CategoryTile'
import { ChevronRight } from './icons'
import { isShortTile } from './TileGrid'
/* The same edge the rail and the product tiles wear — see EDGE_RING in styles.ts. */
import { EDGE_RING, EDGE_LEAD } from './styles'

/**
 * A tile that RUNS SOMETHING — a till quick key, a shortcut on a hub.
 *
 * ── WHY THIS IS NOT ProductTile ───────────────────────────────────────────
 *
 * They look almost the same on purpose and differ in the one place that matters:
 * a `ProductTile` names a THING and shows what it costs, this one names an ACT and
 * shows what it will do. So the third line is a hint rather than a price, and it is
 * `text-muted` rather than bold brand — a cashier scanning for "Cash up" is reading
 * captions, and a column of bold amounts down a grid of verbs is noise pretending to
 * be information.
 *
 * They share `CategoryTile`, `TileGrid` and the same border, radius and press
 * animation, so a quick-key grid and a product grid read as one surface with two
 * kinds of tile on it — which is exactly what the till is.
 *
 * ── WHY THE TILE IS WHITE AND ONLY THE DISC IS COLOURED ───────────────────
 *
 * The earlier till painted the WHOLE tile in the key's colour with white text on it.
 * That loses twice: twenty saturated tiles side by side have no hierarchy left, so
 * nothing stands out, and the caption is the thing a cashier actually reads — white
 * on mid-saturation amber is the worst contrast on the screen. Confining colour to a
 * 44px badge keeps the hue as an IDENTIFIER you find by, while the caption stays ink
 * on surface where it is legible at arm's length.
 *
 * ── HOW THE THREE PARTS ARE ARRANGED ──────────────────────────────────────
 *
 * Badge and caption share the top line; the hint runs the full width beneath them.
 * See the layout itself for why — briefly, the picture and the word for it are one
 * label and must sit together, and the hint describes the key rather than the caption.
 */
export function ActionTile({
  title,
  hint,
  icon,
  tone,
  badge,
  corner,
  chevron = false,
  edge,
  tileHeight = 150,
  disabled = false,
  onClick,
}: {
  title: string
  /** What pressing it does. Dropped on a short tile — the caption carries more. */
  hint?: string
  /** Drawn art or a glyph. Sits in a tinted disc either way. */
  icon?: ReactNode
  tone?: CategoryTone
  /** Top-right — a member count on a folder. */
  badge?: ReactNode
  /** Top-left — the "this will ask for a PIN" mark. */
  corner?: ReactNode
  /** Only where tapping really opens another level. */
  chevron?: boolean
  /**
   * A colour down the leading edge, matching the department rail and the product
   * tiles. On a quick key this is the colour the shop chose for that key.
   */
  edge?: CategoryTone
  tileHeight?: number
  disabled?: boolean
  onClick?: () => void
}) {
  // Same rule as ProductTile, from the same helper: below the threshold a tile
  // cannot stack a disc above two lines of text, so it lays them out in a row and
  // drops the least load-bearing line. A grid where some tiles have reflowed and
  // others have not is worse than either layout on its own.
  const short = isShortTile(tileHeight)

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative flex h-full min-w-0 rounded-card border bg-surface text-left shadow-card transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${
        edge
          ? /* No hover:border-brand with an edge — as one declaration it repaints all
               four sides and takes the key's own colour with it. */
            `${EDGE_RING[edge]} ${EDGE_LEAD[edge]} border-l-4`
          : 'border-border hover:border-brand/50'
      } ${
        short
          ? `items-center gap-3 py-2 pr-3 ${edge ? 'pl-2.5' : 'pl-3'}`
          : /* gap-2 rather than the stack's 2.5: the hint is a note ABOUT the caption
               above it, and a gap wide enough to be read as a separator makes it look
               like a third, unrelated line — see the layout note below. */
            `flex-col gap-2 py-3.5 pr-3.5 ${edge ? 'pl-3' : 'pl-3.5'}`
      }`}
    >
      {/*
        THE ICON SITS BESIDE THE CAPTION, NOT ABOVE IT.

        Both belong to the same act — the picture and the word for it are one label,
        and a cashier reads them as a pair. Stacked, the caption drifted a full disc
        height away from its own icon and landed nearer the hint below it, so a fast
        scan down the grid read picture / picture / picture and then had to go back up
        for the words.

        Side by side they are one line to scan, the hint drops underneath as the second
        thing rather than a competing third, and the tile gains back the vertical room
        the stack was spending — which is what lets a two-line caption and a two-line
        hint both fit at the default height.
      */}
      {short ? (
        <>
          {icon && <CategoryTile icon={icon} tone={tone} size="md" />}
          <span className="flex min-w-0 flex-1 items-start gap-1.5">
            <span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-tight text-ink">
              {title}
            </span>
            {chevron && <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" />}
          </span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2.5">
            {icon && <CategoryTile icon={icon} tone={tone} size="lg" />}
            <span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-tight text-ink">
              {title}
            </span>
            {chevron && <ChevronRight size={16} className="shrink-0 text-muted" />}
          </span>

          {/* Full tile width, under BOTH — it explains the key rather than the
              caption, so indenting it to clear the disc would make it look like a
              continuation of the title instead of a note about the whole thing. */}
          {hint && (
            <span className="line-clamp-3 text-[13px] leading-snug text-muted">{hint}</span>
          )}
        </>
      )}

      {badge && <span className="absolute right-2 top-2">{badge}</span>}
      {corner && <span className="absolute left-2 top-2 text-muted">{corner}</span>}
    </button>
  )
}

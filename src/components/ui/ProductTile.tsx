'use client'

import type { ReactNode } from 'react'
import { CategoryTile, type CategoryTone } from './CategoryTile'
import { isShortTile } from './TileGrid'

/**
 * A tile on the till — a product, a department, a quick key.
 *
 * One component for all three on purpose. On the reference POS these were three
 * separately-written tiles that drifted apart, and a grid where the product
 * tiles and the department tiles are *almost* the same shape reads as a mistake
 * rather than a set. Here the differences are props: a department passes
 * `chevron` because tapping it opens something, a product passes `price`
 * because that is what a cashier is looking for.
 *
 * Lives in the kit rather than in the POS folder because check-ui-kit rightly
 * refuses a hand-rolled <button> outside components/ui — and because a tile is
 * exactly the sort of thing a second screen will want.
 */
export function ProductTile({
  title,
  subtitle,
  price,
  icon,
  tone,
  image,
  chevron = false,
  tileHeight = 150,
  selected = false,
  disabled = false,
  onClick,
}: {
  title: string
  /** A code, a barcode, or "12 keys". Dropped on a short tile — see below. */
  subtitle?: string
  /** Pre-formatted. The tile does no currency formatting of its own. */
  price?: string
  /** Shown in a tinted disc when there is no image. */
  icon?: ReactNode
  tone?: CategoryTone
  /** A product photograph. Wins over the icon when both are given. */
  image?: string
  /**
   * The "this opens something" affordance. Only for tiles that really do — a
   * chevron on a tile that just adds a line to the basket promises a screen
   * that never arrives.
   */
  chevron?: boolean
  tileHeight?: number
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  // The whole responsive story. A short tile cannot stack a 44px disc above two
  // lines of text, so it lays them out in a row and drops the subtitle — the
  // least load-bearing of the three, since a cashier picks by name and price.
  const short = isShortTile(tileHeight)

  const glyph = image ? (
    <img
      src={image}
      alt=""
      className={`shrink-0 rounded-control border border-border object-cover ${
        short ? 'h-8 w-8' : 'h-11 w-11'
      }`}
    />
  ) : icon ? (
    <CategoryTile icon={icon} tone={tone} size={short ? 'md' : 'lg'} />
  ) : null

  // Tall: glyph on top, text below it filling the rest, price pinned to the
  // bottom edge. Short: everything on one row.
  //
  // The chevron sits NEXT TO THE TITLE rather than as a third child of the
  // column — as a sibling of the glyph it becomes its own row in tall mode and
  // lands under the text, which reads as a stray character.
  const heading = (
    <span className="flex min-w-0 items-start gap-2">
      {/* 15px, above the back office's 14px body: read at arm's length on a
          counter screen, not at desk distance. Clamped to two lines so a long
          description cannot push the price out of the tile. */}
      <span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-tight text-ink">
        {title}
      </span>
      {chevron && (
        <span aria-hidden className="shrink-0 text-lg leading-none text-muted">
          ›
        </span>
      )}
    </span>
  )

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-full min-w-0 rounded-card border bg-surface text-left shadow-card transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${
        selected ? 'border-brand bg-brand-soft' : 'border-border hover:border-brand/50'
      } ${short ? 'items-center gap-3 px-3 py-2' : 'flex-col gap-2.5 p-3.5'}`}
    >
      {glyph}

      {/* flex-1 so the column owns the tile's remaining height — that is what
          lets mt-auto below push the price to the bottom edge instead of
          leaving it floating under the title with dead space beneath. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {heading}
        {subtitle && !short && <span className="truncate text-[13px] text-muted">{subtitle}</span>}
        {price && <span className="numeric mt-auto text-base font-bold text-brand">{price}</span>}
      </span>
    </button>
  )
}

'use client'

import type { ReactNode } from 'react'
import { CategoryTile, type CategoryTone } from './CategoryTile'
import { isShortTile } from './TileGrid'
/* The same edge the department rail wears — see EDGE_RING in styles.ts. Shared so a
   tile grid and the rail beside it cannot drift apart. */
import { EDGE_RING, EDGE_LEAD } from './styles'

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
  edge,
  tileHeight = 150,
  selected = false,
  disabled = false,
  dashed = false,
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
  /**
   * A colour down the leading edge, matching the department rail's rows.
   *
   * Usually the same tone as the disc, so the two are one identifier rather than two
   * decorations. Left off where a grid is all one kind of thing — an edge on every
   * tile of a single department is decoration, and that is what makes colour stop
   * meaning anything elsewhere.
   */
  edge?: CategoryTone
  tileHeight?: number
  selected?: boolean
  disabled?: boolean
  /**
   * A dashed brand outline instead of a solid card, for a tile that is not a
   * THING in the grid but a way out of it — the till's Back tile.
   *
   * The same skin as the new-table opener on the tables screen: light blue
   * dashes, a brand disc behind the glyph, and a fill on hover. It also drops
   * the card shadow — a navigation tile sitting on the surface the way the
   * products do reads as one of them, which is what the dashes prevent.
   */
  dashed?: boolean
  onClick?: () => void
}) {
  // The whole responsive story. A short tile has room for ONE line of content
  // beside its badge, so it keeps the name and the price on that line and drops
  // the subtitle — the least load-bearing of the three, since a cashier picks by
  // name and price. A tall tile keeps all three: name beside the badge, code and
  // price on their own lines beneath.
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
    dashed ? (
      /* A BRAND disc, matching the new-table opener rather than the category
         ramp CategoryTile draws from. That ramp means "which kind of thing" —
         and this tile is not a kind of thing, it is the way out of the grid, so
         it takes the same light blue the other dashed tiles wear. */
      <span
        aria-hidden
        /* The same squircle CategoryTile draws at this size — a round disc here
           beside squared badges on every tile around it reads as the odd one out
           rather than as the deliberate exception it is meant to be. */
        className={`flex shrink-0 items-center justify-center rounded-[14px] bg-brand-soft text-brand ${
          short ? 'h-10 w-10' : 'h-11 w-11'
        }`}
      >
        {icon}
      </span>
    ) : (
      <CategoryTile icon={icon} tone={tone} size={short ? 'md' : 'lg'} />
    )
  ) : null

  // Tall: glyph and description share the top line, code and price beneath them.
  // Short: everything on one row.
  //
  // The chevron sits NEXT TO THE TITLE rather than as a third child of the
  // column — as a sibling of the glyph it becomes its own row in tall mode and
  // lands under the text, which reads as a stray character.
  const heading = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
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
      /* w-full as well as h-full: as a direct grid item the tile was stretched to its
         track and never needed it, but a caller that WRAPS the tile — to hang a drag
         handle or a hover action off it — makes this button an ordinary block child
         that sizes to its content instead, and a long product name then renders a tile
         wider than the column it sits in. Filling the box it is given is what the tile
         meant in both cases. */
      className={`flex h-full w-full min-w-0 rounded-card border text-left transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${
        dashed
          ? /* The same skin as the till's new-table opener — see HeroTile in
               TableGate. Both are dashed tiles that start something rather than
               being a thing, and phrasing that two ways on two till screens is
               how a set stops looking like a set. */
            'border-2 border-dashed border-brand/40 bg-surface hover:border-brand hover:bg-brand-soft'
          : 'bg-surface shadow-card'
      } ${
        /* A dashed tile owns its own border entirely — the branches below would
           emit a second, competing border colour at the same specificity, and
           which one won would come down to stylesheet order. */
        dashed
          ? ''
          : selected
            ? /* Selected takes the brand fill and hairline, but keeps its own leading
                 edge: being chosen must not change which product a tile reads as. */
              `border-brand bg-brand-soft ${edge ? EDGE_LEAD[edge] : ''}`
            : edge
              ? /* No hover:border-brand with an edge — as one declaration it repaints
                   all four sides and takes the leading colour with it, so the tile
                   would lose its identity exactly when a finger is on it. */
                `${EDGE_RING[edge]} ${EDGE_LEAD[edge]}`
              : 'border-border hover:border-brand/50'
      } ${edge && !dashed ? 'border-l-4' : ''} ${
        short
          ? `items-center gap-3 py-2 pr-3 ${edge && !dashed ? 'pl-2.5' : 'pl-3'}`
          : /* gap-2, matching ActionTile: the code and price under the top line are
               notes about the product named on it, and a gap wide enough to read as a
               separator makes them look like an unrelated second block. */
            `flex-col gap-2 py-3.5 pr-3.5 ${edge && !dashed ? 'pl-3' : 'pl-3.5'}`
      }`}
    >
      {/*
        THE GLYPH SITS BESIDE THE DESCRIPTION, NOT ABOVE IT — the same arrangement
        the quick keys wear, for the same reason: the picture and the name for it are
        one label, and splitting them by a disc's height makes a scan down the grid
        read every picture first and then go back up for the words.

        Code and price drop underneath, full tile width. They ANSWER the description
        rather than continue it — "which one is it" then "what does it cost" — so
        indenting them to clear the glyph would file them under the name instead of
        under the product.
      */}
      {short ? (
        <>
          {glyph}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {heading}
            {price && <span className="numeric text-base font-bold text-brand">{price}</span>}
          </span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2.5">
            {glyph}
            {heading}
          </span>

          {/* flex-1 so this block owns the tile's remaining height — that is what
              lets mt-auto below hold the price on the bottom edge, where a cashier
              finds it in the same place on every tile in the row rather than at a
              height that moves with the length of the description above it. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {subtitle && <span className="truncate text-[13px] text-muted">{subtitle}</span>}
            {price && (
              <span className="numeric mt-auto text-base font-bold text-brand">{price}</span>
            )}
          </span>
        </>
      )}
    </button>
  )
}

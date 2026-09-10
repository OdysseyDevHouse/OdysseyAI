import type { ReactNode } from 'react'

/**
 * The gap between tiles, in px — this component's own `gap-3`. Named because the
 * fixed-column track maths has to subtract it, and a grid whose CSS gap and
 * arithmetic disagree lays out one column short at exactly one width.
 */
const GAP = 12

/**
 * A grid of touch tiles — products, departments, quick keys.
 *
 * ONE recipe, shared by every tile grid on the till, so the three panels read as
 * one system rather than three similar things:
 *
 *     repeat(auto-fill, minmax(min(TILEW, 100%), 1fr))
 *
 * `minmax(W, 1fr)` makes W a MINIMUM, not a width: fit as many columns as go in,
 * then stretch them to fill the row edge to edge. So the tile size steps rather
 * than sliding, and a row is always flush — which reads better on a till than an
 * exact width with a ragged strip of dead space down the right.
 *
 * The inner `min(W, 100%)` is what stops a single tile overflowing a pane
 * narrower than one tile: without it, `minmax(200px, 1fr)` in a 180px column
 * forces a 200px track and the pane scrolls sideways.
 *
 * Height is fixed rather than aspect-derived. A tile holding a two-line product
 * description must be exactly as tall as the one beside it holding one line, or
 * the grid gains ragged rows the eye reads as broken.
 *
 * `columns` opts out of the auto-fill count and asks for exactly that many tracks
 * — for a grid whose shape is the composition, like the department shelf a manager
 * arranges and then recognises by its layout, where a wider monitor quietly adding
 * a seventh column is the arrangement changing under them. `tileWidth` stays the
 * floor, so a pane too narrow for that many drops back to fitting what it can
 * rather than crushing every tile.
 */
export function TileGrid({
  tileWidth = 200,
  tileHeight = 150,
  columns,
  children,
  className = '',
}: {
  /**
   * Minimum tile width in px. Columns grow past this to fill the row.
   *
   * 110–420 is the useful range: below ~110 a price and a description stop
   * fitting, above ~420 a tile stops reading as one of a set.
   */
  tileWidth?: number
  /** Tile height in px. Below SHORT_TILE_MAX tiles lay out side-by-side. */
  tileHeight?: number
  /**
   * Ask for exactly this many columns instead of fitting as many as go in.
   * `tileWidth` remains the floor: a pane too narrow for that many tracks drops
   * back to auto-fill rather than crushing every tile.
   */
  columns?: number
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{
        gridTemplateColumns: columns
          ? /* max(floor, one Nth of the row) keeps the fixed count while `tileWidth`
               still guards the narrow end: once an Nth drops below the floor, the
               floor wins and auto-fill lays out fewer, wider tiles instead. */
            `repeat(auto-fill, minmax(max(${tileWidth}px, calc((100% - ${
              (columns - 1) * GAP
            }px) / ${columns})), 1fr))`
          : `repeat(auto-fill, minmax(min(${tileWidth}px, 100%), 1fr))`,
        gridAutoRows: `${tileHeight}px`,
      }}
    >
      {children}
    </div>
  )
}

/**
 * Below this height a tile cannot stack its glyph above its text and still fit
 * both, so tiles flip to a side-by-side row instead.
 *
 * Exported so ProductTile, and later the quick-key tile, make that decision the
 * same way — a grid where some tiles have reflowed and others have not is worse
 * than either layout on its own.
 */
export const SHORT_TILE_MAX = 128

/** Whether a tile of this height should lay itself out as a row. */
export function isShortTile(tileHeight: number): boolean {
  return tileHeight < SHORT_TILE_MAX
}

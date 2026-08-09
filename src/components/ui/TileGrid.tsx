import type { ReactNode } from 'react'

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
 */
export function TileGrid({
  tileWidth = 200,
  tileHeight = 150,
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
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${tileWidth}px, 100%), 1fr))`,
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

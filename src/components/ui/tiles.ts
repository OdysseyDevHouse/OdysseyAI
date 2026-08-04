/**
 * The swatch palette offered wherever a record is given a colour — a product
 * with no photo, a department in the picker.
 *
 * Values are tokens (--color-tile-* in globals.css), not hex: a record stores
 * the token name, so restyling the palette repaints existing records instead of
 * leaving them pinned to an old literal.
 *
 * Class strings are written out in full and never built by interpolation —
 * Tailwind scans source text, so a computed `bg-${token}` would not be emitted.
 */

export type TileSwatch = { token: string; className: string }

export const TILE_SWATCHES: readonly TileSwatch[] = [
  { token: 'tile-1', className: 'bg-tile-1' },
  { token: 'tile-2', className: 'bg-tile-2' },
  { token: 'tile-3', className: 'bg-tile-3' },
  { token: 'tile-4', className: 'bg-tile-4' },
  { token: 'tile-5', className: 'bg-tile-5' },
  { token: 'tile-6', className: 'bg-tile-6' },
  { token: 'tile-7', className: 'bg-tile-7' },
]

/**
 * The background class for a stored token.
 *
 * Falls back to the first swatch rather than rendering nothing: rows written
 * before these became tokens still hold a hex string, and a half-painted tile
 * is worse than a differently-coloured one.
 */
export function tileClass(token: string | null | undefined): string {
  return TILE_SWATCHES.find((t) => t.token === token)?.className ?? TILE_SWATCHES[0].className
}

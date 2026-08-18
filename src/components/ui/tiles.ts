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

import type { CategoryTone } from './CategoryTile'

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
 * The gradient options, offered beside the flat swatches.
 *
 * ── REBUILT, NOT RECOVERED ────────────────────────────────────────────────
 *
 * The original definition was lost (see RECOVERY-NOTES.md) and nothing recorded what
 * it held: `products.image_color` is empty on every site, so no stored row names a
 * gradient token. These are therefore NEW names, and any till tile that had been
 * saved under the old ones would fall back to flat `tile-1`. Nothing has, so nothing
 * is affected — but that is why the names could not simply be guessed and left to
 * chance.
 *
 * Built from the SAME `--color-tile-*` tokens as the flat swatches rather than new
 * colours, so the two rows read as one palette and restyling still means editing
 * globals.css alone. Each is a pair, so the gradient is visibly a gradient at 24px in
 * the picker — two adjacent hues would look like a rendering fault.
 *
 * Class strings written out in full, never interpolated: Tailwind scans source text,
 * so a computed `from-${token}` is not emitted and the swatch renders blank.
 */
export const TILE_GRADIENTS: readonly TileSwatch[] = [
  { token: 'tile-grad-1', className: 'bg-gradient-to-br from-tile-1 to-tile-6' },
  { token: 'tile-grad-2', className: 'bg-gradient-to-br from-tile-2 to-tile-3' },
  { token: 'tile-grad-3', className: 'bg-gradient-to-br from-tile-4 to-tile-5' },
  { token: 'tile-grad-4', className: 'bg-gradient-to-br from-tile-5 to-tile-1' },
  { token: 'tile-grad-5', className: 'bg-gradient-to-br from-tile-6 to-tile-2' },
  { token: 'tile-grad-6', className: 'bg-gradient-to-br from-tile-3 to-tile-4' },
  { token: 'tile-grad-7', className: 'bg-gradient-to-br from-tile-7 to-tile-5' },
]

/**
 * The 20 picture gradients, as till-tile tokens.
 *
 * ── WHY THESE EXIST BESIDE TILE_GRADIENTS ─────────────────────────────────
 *
 * The same ramps the generated-picture dialog offers (lib/generatedPicture), so
 * a shop choosing a colour for a till button and a shop generating an icon are
 * picking from ONE palette rather than two that nearly match. The product till
 * tile offers these; departments and the shared SwatchPicker keep TILE_SWATCHES
 * / TILE_GRADIENTS, which is why both sets are still here.
 *
 * `pic-*` rather than `tile-grad-*` so an existing stored token keeps meaning
 * exactly what it meant — nothing silently repaints.
 *
 * Ink is NOT uniform: the pale ramps carry dark text, matching inkFor() in
 * lib/generatedPicture so a colour-only tile and a generated icon of the same
 * ramp look alike. See PIC_DARK_INK below.
 *
 * Class strings written out in full, never interpolated — Tailwind scans source
 * text, so a computed `from-${token}` is not emitted and the swatch renders
 * blank. That is also why this list is verbose rather than mapped.
 */
export const PICTURE_TILE_GRADIENTS: readonly TileSwatch[] = [
  { token: 'pic-green', className: 'bg-gradient-to-br from-pic-green-from to-pic-green-to' },
  { token: 'pic-lime', className: 'bg-gradient-to-br from-pic-lime-from to-pic-lime-to' },
  { token: 'pic-teal', className: 'bg-gradient-to-br from-pic-teal-from to-pic-teal-to' },
  { token: 'pic-aqua', className: 'bg-gradient-to-br from-pic-aqua-from to-pic-aqua-to' },
  { token: 'pic-blue', className: 'bg-gradient-to-br from-pic-blue-from to-pic-blue-to' },
  {
    token: 'pic-deep-blue',
    className: 'bg-gradient-to-br from-pic-deep-blue-from to-pic-deep-blue-to',
  },
  { token: 'pic-indigo', className: 'bg-gradient-to-br from-pic-indigo-from to-pic-indigo-to' },
  { token: 'pic-purple', className: 'bg-gradient-to-br from-pic-purple-from to-pic-purple-to' },
  { token: 'pic-violet', className: 'bg-gradient-to-br from-pic-violet-from to-pic-violet-to' },
  { token: 'pic-magenta', className: 'bg-gradient-to-br from-pic-magenta-from to-pic-magenta-to' },
  { token: 'pic-pink', className: 'bg-gradient-to-br from-pic-pink-from to-pic-pink-to' },
  { token: 'pic-rose', className: 'bg-gradient-to-br from-pic-rose-from to-pic-rose-to' },
  { token: 'pic-red', className: 'bg-gradient-to-br from-pic-red-from to-pic-red-to' },
  { token: 'pic-orange', className: 'bg-gradient-to-br from-pic-orange-from to-pic-orange-to' },
  {
    token: 'pic-deep-orange',
    className: 'bg-gradient-to-br from-pic-deep-orange-from to-pic-deep-orange-to',
  },
  { token: 'pic-amber', className: 'bg-gradient-to-br from-pic-amber-from to-pic-amber-to' },
  { token: 'pic-yellow', className: 'bg-gradient-to-br from-pic-yellow-from to-pic-yellow-to' },
  { token: 'pic-gold', className: 'bg-gradient-to-br from-pic-gold-from to-pic-gold-to' },
  { token: 'pic-brown', className: 'bg-gradient-to-br from-pic-brown-from to-pic-brown-to' },
  { token: 'pic-slate', className: 'bg-gradient-to-br from-pic-slate-from to-pic-slate-to' },
]

/**
 * The ramps whose LIGHT stop is too pale for white text.
 *
 * Kept as an explicit list rather than measured at render time: the same four
 * fall out of inkFor()'s luminance test in lib/generatedPicture, and a tile that
 * disagreed with the icon drawn on it would be the bug this prevents. If a ramp
 * is added there, check it here.
 */
const PIC_DARK_INK = new Set(['pic-lime', 'pic-amber', 'pic-yellow', 'pic-gold'])

/**
 * Each picture ramp's nearest `cat-*` tone, for the POS.
 *
 * Twenty ramps onto nine tones, matched by hue — several necessarily share one.
 * That is fine and not a loss: a cat-* tone paints a few pixels of edge or a
 * small disc, where "green-ish" is the whole of what reads at arm's length.
 * The full gradient is still what the tile itself wears.
 */
const PIC_TONES: Record<string, CategoryTone> = {
  'pic-green': 'emerald',
  'pic-lime': 'emerald',
  'pic-teal': 'teal',
  'pic-aqua': 'teal',
  'pic-blue': 'sky',
  'pic-deep-blue': 'indigo',
  'pic-indigo': 'indigo',
  'pic-purple': 'violet',
  'pic-violet': 'violet',
  'pic-magenta': 'rose',
  'pic-pink': 'rose',
  'pic-rose': 'rose',
  'pic-red': 'rose',
  'pic-orange': 'orange',
  'pic-deep-orange': 'orange',
  'pic-amber': 'amber',
  'pic-yellow': 'amber',
  'pic-gold': 'amber',
  'pic-brown': 'slate',
  'pic-slate': 'slate',
}

/**
 * The text colour a till tile needs over `token` — dark on the pale ramps,
 * white on everything else. Returns a full class string, never a fragment.
 */
export function tileInkClass(token: string | null | undefined): string {
  return token && PIC_DARK_INK.has(token) ? 'text-pic-ink-dark' : 'text-white'
}

/**
 * "No background at all", as a token rather than an empty string.
 *
 * A named value so the picker can show it as pressed and the stored row says what was
 * MEANT. An empty string cannot: it is indistinguishable from "never chosen", and the
 * two need different renderings — an unset product falls back to a colour, one
 * deliberately set to none must stay bare.
 */
export const TILE_NONE = { token: 'tile-none', className: 'bg-surface-2' } as const

/**
 * The background class for a stored token.
 *
 * Falls back to the first swatch rather than rendering nothing: rows written
 * before these became tokens still hold a hex string, and a half-painted tile
 * is worse than a differently-coloured one.
 *
 * Gradients and the explicit "none" are looked up too — a picker offering options that
 * render as flat blue is worse than one offering fewer.
 */
/**
 * The `cat-*` tone nearest a stored `tile-*` swatch.
 *
 * The two palettes exist for different jobs — `tile-*` is a saturated fill meant to
 * carry white text, `cat-*` is a foreground/tint pair for a disc or an edge — so a
 * record that stored one needs translating before it can colour the other. Matched by
 * hue: tile-1 is the brand blue, so indigo; tile-4 is a red, so rose.
 *
 * A gradient token maps to the tone of the swatch it starts from, since an edge is a
 * few pixels wide and a gradient across it would read as a slightly-off flat colour
 * rather than as a gradient.
 *
 * Returns null for an unknown or absent token — "no colour was chosen" is a real
 * answer, and the caller decides what to fall back to rather than being handed an
 * arbitrary hue that looks deliberate.
 */
export function toneForTileToken(token: string | null | undefined): CategoryTone | null {
  if (!token) return null

  /*
   * The picture ramps map by hue to the nearest cat-* tone.
   *
   * Without this every `pic-*` token fell through to null and the POS quietly
   * coloured the button from the DEPARTMENT instead — the colour a shop had
   * deliberately chosen would simply not appear on the till, which is the one
   * place it is meant to.
   */
  if (token.startsWith('pic-')) return PIC_TONES[token] ?? 'slate'

  const base = token.startsWith('tile-grad-')
    ? TILE_GRADIENTS.find((g) => g.token === token)?.className.match(/from-(tile-\d)/)?.[1]
    : token
  switch (base) {
    case 'tile-1':
      return 'indigo'
    case 'tile-2':
      return 'emerald'
    case 'tile-3':
      return 'amber'
    case 'tile-4':
      return 'rose'
    case 'tile-5':
      return 'violet'
    case 'tile-6':
      return 'teal'
    case 'tile-7':
      return 'slate'
    default:
      return null
  }
}

export function tileClass(token: string | null | undefined): string {
  if (token === TILE_NONE.token) return TILE_NONE.className
  return (
    TILE_SWATCHES.find((t) => t.token === token)?.className ??
    TILE_GRADIENTS.find((t) => t.token === token)?.className ??
    PICTURE_TILE_GRADIENTS.find((t) => t.token === token)?.className ??
    TILE_SWATCHES[0].className
  )
}

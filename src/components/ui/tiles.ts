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

/**
 * A category colour: a swatch that also carries the name it was drawn for.
 *
 * `hex` duplicates the value in globals.css deliberately — the picker shows it
 * so a shop can match a tile to signage, and CSS custom properties cannot be
 * read back as text. Keep the two in step; globals.css is the source of truth
 * for what actually paints.
 */
export type CategorySwatch = TileSwatch & { label: string; hex: string; tone: CategoryTone }

/**
 * The 20 flat category colours — the palette every tile picker now offers.
 *
 * ── WHY THESE REPLACED THE GRADIENTS ──────────────────────────────────────
 *
 * The `pic-*` ramps are still defined below and still render, because a stored
 * row may name one and must keep looking like itself. They are simply no longer
 * OFFERED: a wall of till buttons is read at arm's length, where twenty flat
 * colours separate and twenty two-stop ramps smear together.
 *
 * ── THE NAMES ─────────────────────────────────────────────────────────────
 *
 * Each is named for the department it was drawn for. Nothing enforces the
 * pairing — any record may take any colour — but the name is what makes a
 * twenty-swatch grid pickable: "Bakery" is a colour a person can ask for, where
 * "amber" is one they have to hunt for.
 *
 * ── INK ───────────────────────────────────────────────────────────────────
 *
 * All twenty carry white text, matching the supplied palette. Measured against
 * white on the WCAG curve, nine land below 3:1 — Household (#C2A878) is the
 * worst at 2.29 — so this is a chosen trade, not an unchecked one. If these are
 * ever meant to meet contrast, the pale end needs darkening rather than the ink
 * flipping, since the label sits on the tile in the product grid too.
 *
 * Class strings written out in full, never interpolated: Tailwind scans source
 * text, so a computed `bg-${token}` is not emitted and the swatch renders bare.
 */
export const CATEGORY_SWATCHES: readonly CategorySwatch[] = [
  { token: 'cat-butchery', label: 'Butchery', hex: '#DC4C4C', className: 'bg-cat-butchery', tone: 'rose' },
  { token: 'cat-hot-food', label: 'Hot Food', hex: '#EF6F4E', className: 'bg-cat-hot-food', tone: 'orange' },
  { token: 'cat-snacks', label: 'Snacks', hex: '#E08A3C', className: 'bg-cat-snacks', tone: 'orange' },
  { token: 'cat-bakery', label: 'Bakery', hex: '#D2A032', className: 'bg-cat-bakery', tone: 'amber' },
  {
    token: 'cat-fresh-produce',
    label: 'Fresh Produce',
    hex: '#9AB43F',
    className: 'bg-cat-fresh-produce',
    tone: 'emerald',
  },
  { token: 'cat-fruit-veg', label: 'Fruit & Veg', hex: '#4CAF6D', className: 'bg-cat-fruit-veg', tone: 'emerald' },
  { token: 'cat-deli', label: 'Deli', hex: '#2FA98C', className: 'bg-cat-deli', tone: 'teal' },
  { token: 'cat-health', label: 'Health', hex: '#8CA98F', className: 'bg-cat-health', tone: 'emerald' },
  { token: 'cat-frozen', label: 'Frozen', hex: '#2C9AA6', className: 'bg-cat-frozen', tone: 'teal' },
  { token: 'cat-dairy', label: 'Dairy', hex: '#3C9FD6', className: 'bg-cat-dairy', tone: 'sky' },
  { token: 'cat-beverages', label: 'Beverages', hex: '#4272D9', className: 'bg-cat-beverages', tone: 'indigo' },
  { token: 'cat-cleaning', label: 'Cleaning', hex: '#5C7B94', className: 'bg-cat-cleaning', tone: 'slate' },
  { token: 'cat-airtime', label: 'Airtime', hex: '#5D5BD4', className: 'bg-cat-airtime', tone: 'indigo' },
  { token: 'cat-stationery', label: 'Stationery', hex: '#8A5CD1', className: 'bg-cat-stationery', tone: 'violet' },
  {
    token: 'cat-confectionery',
    label: 'Confectionery',
    hex: '#A855C4',
    className: 'bg-cat-confectionery',
    tone: 'violet',
  },
  { token: 'cat-baby', label: 'Baby', hex: '#DB5A9B', className: 'bg-cat-baby', tone: 'rose' },
  { token: 'cat-alcohol', label: 'Alcohol', hex: '#8E3B5A', className: 'bg-cat-alcohol', tone: 'rose' },
  { token: 'cat-pet', label: 'Pet', hex: '#B4674A', className: 'bg-cat-pet', tone: 'orange' },
  { token: 'cat-household', label: 'Household', hex: '#C2A878', className: 'bg-cat-household', tone: 'amber' },
  { token: 'cat-tobacco', label: 'Tobacco', hex: '#5A6470', className: 'bg-cat-tobacco', tone: 'slate' },
]

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
 *
 * The `cat-*` palette is uniformly white and never reaches PIC_DARK_INK, which
 * only ever held `pic-*` tokens — see the ink note on CATEGORY_SWATCHES.
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

  /* The category colours carry their own tone, so the POS edge matches the
     tile rather than being re-derived by hue. Checked first: `cat-` and the
     `cat-*` CategoryTone names are different namespaces that would otherwise
     be easy to confuse. */
  const category = CATEGORY_SWATCHES.find((c) => c.token === token)
  if (category) return category.tone

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
    CATEGORY_SWATCHES.find((t) => t.token === token)?.className ??
    TILE_SWATCHES.find((t) => t.token === token)?.className ??
    TILE_GRADIENTS.find((t) => t.token === token)?.className ??
    PICTURE_TILE_GRADIENTS.find((t) => t.token === token)?.className ??
    TILE_SWATCHES[0].className
  )
}

/**
 * Is this something a colour column can legitimately hold?
 *
 * ── WHY THIS IS DERIVED AND NOT A REGEX ───────────────────────────────────
 *
 * It has already gone wrong twice by being written out by hand. Every colour
 * check in the app used to carry its own literal pattern, and each one froze
 * the palette as it stood on the day it was typed:
 *
 *   · `validateDepartment` demanded `#RRGGBB`, from when the picker offered a
 *     colour wheel. It rejected all twenty swatches with "Colour must be a hex
 *     value like #2f6fed." — a message naming a format no screen can produce.
 *   · `patchDepartment` was updated to `tile-1…7` when the palette became
 *     tokens, and its own comment says it exists because the hex rule would
 *     reject them. The palette then moved to `cat-*` and it went stale in
 *     exactly the same way, on the same field, for the same reason.
 *
 * Both failures are silent to every test that does not name a specific token,
 * and invisible to tsc, because a palette is data and a regex is a string. So
 * this reads the palettes themselves: adding a swatch makes it storable, and
 * there is no second place to remember.
 *
 * Hex is still accepted, and deliberately. Rows predating the token palettes
 * hold `#ff0000`, `tileClass` still renders it, and a validator that refused it
 * would make every one of those departments unsaveable the next time somebody
 * edited its NAME — a colour rule breaking a field that has nothing to do with
 * colour.
 */
export function isStorableSwatch(value: string): boolean {
  const v = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return true
  if (v === TILE_NONE.token) return true
  return (
    CATEGORY_SWATCHES.some((s) => s.token === v) ||
    TILE_SWATCHES.some((s) => s.token === v) ||
    TILE_GRADIENTS.some((s) => s.token === v) ||
    PICTURE_TILE_GRADIENTS.some((s) => s.token === v)
  )
}

/**
 * The longest token any palette can currently produce.
 *
 * Not used at runtime — it exists so a test can assert the DB column is still
 * wide enough for the palette, which is the half of this that a validator
 * cannot check. `departments.color` was VARCHAR(9) while the picker emitted
 * `cat-fresh-produce`, so eleven swatches saved and nine were refused by
 * MariaDB with ER_DATA_TOO_LONG — taking the whole record's save with them.
 */
export function longestSwatchToken(): string {
  return [
    TILE_NONE.token,
    ...CATEGORY_SWATCHES.map((s) => s.token),
    ...TILE_SWATCHES.map((s) => s.token),
    ...TILE_GRADIENTS.map((s) => s.token),
    ...PICTURE_TILE_GRADIENTS.map((s) => s.token),
  ].reduce((a, b) => (b.length > a.length ? b : a))
}

/**
 * Every token any picker can produce, as one set.
 *
 * The token-only counterpart to `isStorableSwatch`, for the columns that hold a
 * token and never a hex string — a quick key's colour, say. Kept separate
 * rather than adding a flag, because the two callers want genuinely different
 * things: a department's colour column carries legacy hex that must keep
 * working, and a quick key's has never held one, so accepting hex there would
 * store a value the till's `tileClass` would have to guess at.
 *
 * Derived, for the reason given on `isStorableSwatch`: this exact check was
 * written out by hand in quickKeys.ts over TILE_SWATCHES and TILE_GRADIENTS,
 * and when the inspector moved to the shared SwatchPicker — which offers
 * CATEGORY_SWATCHES — every colour on screen became one the server refused.
 */
export const ALL_SWATCH_TOKENS: ReadonlySet<string> = new Set<string>([
  ...CATEGORY_SWATCHES.map((s) => s.token),
  ...TILE_SWATCHES.map((s) => s.token),
  ...TILE_GRADIENTS.map((s) => s.token),
  ...PICTURE_TILE_GRADIENTS.map((s) => s.token),
  TILE_NONE.token,
])

/**
 * The shop's own look — surfaces, ink, corners, spacing, buttons, width.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * A shop could change exactly one thing about how it looked: its brand colour,
 * injected as a single CSS variable over the storefront subtree. Everything
 * else — the surfaces behind the cards, the text colours, the corner radius,
 * the spacing, the header — came from `globals.css`, which is the BACK
 * OFFICE's palette. Two shops differed by an accent and a logo, and a butchery
 * and a boutique rendered as the same shop twice.
 *
 * ── KEYS, NOT VALUES ─────────────────────────────────────────────────────
 *
 * Every control here is a key into a curated list, the same decision `fontKey`
 * already documents. An owner picks "paper" or "round"; they do not type a hex
 * for a surface or a pixel count for a radius. That is what keeps the result
 * legible: the pairings below were checked for contrast when they were
 * written, so there is no combination of them that produces unreadable text.
 * The two free-hex fields — the brand and accent colours — stay free, because
 * a shop with real brand colours must be able to type theirs, and they are
 * checked at the point of choosing instead.
 *
 * ── AND WHY THEY LIVE HERE, NOT IN globals.css ───────────────────────────
 *
 * `globals.css` is the app's single source of truth and the house rule says no
 * component may write a raw colour. These are not the app's colours: they are a
 * SHOP's, a piece of that store's data, validated on the way in and injected
 * into a public page. `BRAND_SWATCHES` already sits in the model for exactly
 * this reason, and its comment makes the argument in full.
 */

/* ── The controls ─────────────────────────────────────────────────────────── */

/**
 * The surfaces a page is built from: the canvas behind everything, the cards
 * on it, and the hairlines between.
 *
 * Five, and each one changes the whole feel of a shop from across the room.
 * `bright` is what every shop has today, so "no change" stays a choice.
 */
export const SURFACE_STYLES = ['bright', 'warm', 'cool', 'paper', 'ink'] as const
export type SurfaceStyle = (typeof SURFACE_STYLES)[number]

/** How warm or cold the text reads. Paired with a surface, never alone. */
export const INK_STYLES = ['neutral', 'warm', 'cool'] as const
export type InkStyle = (typeof INK_STYLES)[number]

/** How rounded everything is: buttons, inputs, cards, tiles. */
export const CORNER_STYLES = ['sharp', 'soft', 'round', 'pill'] as const
export type CornerStyle = (typeof CORNER_STYLES)[number]

/** How much room the page gives itself. */
export const DENSITIES = ['compact', 'comfortable', 'airy'] as const
export type Density = (typeof DENSITIES)[number]

/**
 * How a button is drawn.
 *
 * A named style rather than a set of colour fields: `outline` on a dark
 * surface has to invert, and an owner choosing "outline" means the look, not
 * the four values that produce it on whichever surface they also picked.
 */
export const BUTTON_STYLES = ['solid', 'outline', 'soft'] as const
export type ButtonStyle = (typeof BUTTON_STYLES)[number]

/** How wide the content column runs. */
export const PAGE_WIDTHS = ['narrow', 'standard', 'wide'] as const
export type PageWidth = (typeof PAGE_WIDTHS)[number]

/**
 * How tightly product tiles pack.
 *
 * On the theme rather than per-listing because it is a LOOK, not a rule about
 * one department: a shop that wants big tiles wants them everywhere.
 */
export const PRODUCT_DENSITIES = ['roomy', 'standard', 'dense'] as const
export type ProductDensity = (typeof PRODUCT_DENSITIES)[number]

/**
 * The shop's design tokens, as stored.
 *
 * Everything optional-free: `readDesignTokens` fills every field, so a caller
 * never has to ask whether a shop has chosen yet. What a shop has not chosen
 * is DEFAULT_TOKENS, which is today's look exactly.
 */
export type DesignTokens = {
  surfaceStyle: SurfaceStyle
  inkStyle: InkStyle
  cornerStyle: CornerStyle
  density: Density
  buttonStyle: ButtonStyle
  pageWidth: PageWidth
  productDensity: ProductDensity
  /**
   * A second colour, for the things that are not the brand: a sale badge, a
   * countdown, the struck-through price it replaces.
   *
   * Empty means "derive from the brand", which is what every shop does today.
   * Kept as '' rather than null so the whole token object is a flat record of
   * strings — it is stored as JSON and compared as JSON.
   */
  accentColour: string
  /**
   * The face headings are set in, or '' for "the same as the body".
   *
   * A pairing is the cheapest way to make two shops look genuinely different —
   * serif headings over a sans body reads as designed in a way no colour does.
   * A key into the same curated list the body font uses, never a family name.
   */
  headingFontKey: string
}

/** Today's look, exactly. A shop that has chosen nothing gets this. */
export const DEFAULT_TOKENS: DesignTokens = {
  surfaceStyle: 'bright',
  inkStyle: 'neutral',
  cornerStyle: 'soft',
  density: 'comfortable',
  buttonStyle: 'solid',
  pageWidth: 'standard',
  productDensity: 'standard',
  accentColour: '',
  headingFontKey: '',
}

/* ── What each key resolves to ────────────────────────────────────────────── */

/**
 * The surface palettes.
 *
 * ── THESE NUMBERS WERE CHECKED, NOT CHOSEN BY EYE ────────────────────────
 *
 * Every surface here was run against every ink below at WCAG AA (4.5) for
 * `ink`, `ink2` AND `muted`, on all three backgrounds. The first draft failed
 * in eight places — all of them `muted` on the tinted fill, all of them the
 * kind of "slightly grey on slightly beige" that looks fine to whoever picked
 * it and is unreadable in daylight on a phone. The muted inks below are the
 * darkened ones that clear it; the tightest pairing left is paper/cool muted
 * on surface-2 at 4.84.
 *
 * That check is the whole reason these are keys and not colour fields. An
 * owner cannot reach a failing combination because every combination was
 * verified before it was offered.
 */
export const SURFACE_PALETTES: Record<SurfaceStyle, {
  canvas: string; surface: string; surface2: string; border: string; borderStrong: string
  /** True when this palette is dark, so the ink flips and `color-scheme` follows. */
  dark?: boolean
}> = {
  // Today's shop, exactly — so choosing "no change" is a real option.
  bright: { canvas: '#f6f7f9', surface: '#ffffff', surface2: '#f2f4f7', border: '#e4e7ec', borderStrong: '#d0d5dd' },
  warm: { canvas: '#faf7f2', surface: '#ffffff', surface2: '#f5efe6', border: '#ece3d6', borderStrong: '#dbcdb8' },
  cool: { canvas: '#f4f7fa', surface: '#ffffff', surface2: '#eaf0f6', border: '#dde6ef', borderStrong: '#c5d3e2' },
  paper: { canvas: '#f3efe7', surface: '#fdfbf7', surface2: '#eae4d8', border: '#ddd4c4', borderStrong: '#c7bba5' },
  ink: { canvas: '#14171c', surface: '#1c2027', surface2: '#252b34', border: '#2f3742', borderStrong: '#455160', dark: true },
}

/** The ink palettes for a light surface. See SURFACE_PALETTES on the check. */
export const INK_PALETTES: Record<InkStyle, {
  ink: string; ink2: string; muted: string; faint: string
}> = {
  neutral: { ink: '#16191d', ink2: '#344054', muted: '#586274', faint: '#98a2b3' },
  warm: { ink: '#1f1a14', ink2: '#443a2c', muted: '#635646', faint: '#9c8f7e' },
  cool: { ink: '#111a22', ink2: '#2c3d4d', muted: '#516475', faint: '#8ba0b0' },
}

/**
 * The ink for a DARK surface.
 *
 * One set rather than three, because the warm/cool distinction is a choice
 * about black on paper and does not survive being inverted — a "warm" pale
 * grey on near-black reads as a tint, not a temperature. The chosen inkStyle
 * is simply not consulted when the surface is dark, which is a better answer
 * than offering three options that produce the same page.
 */
export const INK_ON_DARK = { ink: '#e9edf2', ink2: '#c9d2dc', muted: '#9dabba', faint: '#6f7d8c' }

/** Corner radii, as the two variables the whole storefront resolves through. */
export const CORNER_RADII: Record<CornerStyle, { control: string; card: string }> = {
  sharp: { control: '2px', card: '3px' },
  soft: { control: '8px', card: '12px' },
  round: { control: '14px', card: '20px' },
  // Not 9999px on the card: a pill-shaped CARD is a lozenge nobody wants. The
  // control goes fully round and the card follows at a large-but-finite radius.
  pill: { control: '9999px', card: '24px' },
}

/** The rhythm of the page: the gap between sections, and a band's padding. */
export const DENSITY_SPACING: Record<Density, { sectionGap: string; bandPad: string; control: string }> = {
  compact: { sectionGap: '1.5rem', bandPad: '1.25rem', control: '2.25rem' },
  comfortable: { sectionGap: '2.5rem', bandPad: '2rem', control: '2.5rem' },
  airy: { sectionGap: '4rem', bandPad: '3.25rem', control: '2.75rem' },
}

/** How wide the content column runs. */
export const PAGE_MAX_WIDTH: Record<PageWidth, string> = {
  narrow: '64rem',
  standard: '72rem',
  wide: '87.5rem',
}

/**
 * Product grid columns, as a full class string per density.
 *
 * WRITTEN OUT, never built. Tailwind extracts class names statically, so
 * `grid-cols-${n}` is a class that does not exist in the stylesheet and the
 * grid silently collapses to one column. The renderer maps a name to a string
 * it wrote itself — the same rule `RICH_COLOURS` follows.
 */
export const PRODUCT_GRID_CLASS: Record<ProductDensity, string> = {
  roomy: 'grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-3 @xl:grid-cols-4',
  standard: 'grid-cols-2 @sm:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5',
  dense: 'grid-cols-2 @sm:grid-cols-4 @lg:grid-cols-5 @xl:grid-cols-6',
}

/* ── Reading them back ────────────────────────────────────────────────────── */

/** One of a fixed list, or the default. Anything unrecognised fails safe. */
function pick<T extends string>(value: unknown, of: readonly T[], fallback: T): T {
  const raw = String(value ?? '')
  return (of as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/**
 * Coerce a stored blob into a complete set of tokens.
 *
 * Fails safe in one direction only: every unrecognised value becomes the
 * DEFAULT, which is today's look. A hand-crafted payload therefore produces
 * the shop as it already renders, never a broken one — the same stance
 * `normaliseSections` takes, and for the same reason: this is read from a
 * column a browser's save wrote.
 */
export function readDesignTokens(raw: unknown): DesignTokens {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    surfaceStyle: pick(o.surfaceStyle, SURFACE_STYLES, DEFAULT_TOKENS.surfaceStyle),
    inkStyle: pick(o.inkStyle, INK_STYLES, DEFAULT_TOKENS.inkStyle),
    cornerStyle: pick(o.cornerStyle, CORNER_STYLES, DEFAULT_TOKENS.cornerStyle),
    density: pick(o.density, DENSITIES, DEFAULT_TOKENS.density),
    buttonStyle: pick(o.buttonStyle, BUTTON_STYLES, DEFAULT_TOKENS.buttonStyle),
    pageWidth: pick(o.pageWidth, PAGE_WIDTHS, DEFAULT_TOKENS.pageWidth),
    productDensity: pick(o.productDensity, PRODUCT_DENSITIES, DEFAULT_TOKENS.productDensity),
    // Strict hex or nothing. This lands in a style attribute on a public page,
    // so anything not unmistakably a colour is dropped rather than trusted —
    // see safeColour, whose rule this follows.
    accentColour: HEX.test(String(o.accentColour ?? '').trim())
      ? String(o.accentColour).trim()
      : '',
    headingFontKey: String(o.headingFontKey ?? ''),
  }
}

/** Strict hex only. Kept beside its one caller — see readDesignTokens. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Is this palette dark? The one question the rest of the app asks by name.
 *
 * Derived from the palette rather than stored, so a shop cannot end up with a
 * `dark` flag that disagrees with the surfaces it actually has.
 */
export function isDarkTheme(tokens: DesignTokens): boolean {
  return SURFACE_PALETTES[tokens.surfaceStyle].dark === true
}

/**
 * The CSS variables a shop's subtree overrides.
 *
 * ── EVERY VARIABLE, UNCONDITIONALLY ──────────────────────────────────────
 *
 * Including the ones whose value equals the default. The storefront sits
 * inside the app's stylesheet, which redefines all of these under
 * `prefers-color-scheme: dark` — so emitting only what a shop CHANGED would
 * leave the rest following the shopper's phone, and a shop that picked
 * "paper" would render as paper cards on the back office's near-black canvas
 * for every shopper with dark mode on. Writing them all leaves that media
 * query nothing to win.
 *
 * That is a deliberate decision about whose preference wins, and it is the
 * shop's: a storefront's look is a brand decision, and neither Shopify nor
 * WooCommerce flips a shop to dark because a visitor's OS is. A shopper's
 * setting is a reading preference for APPS. `color-scheme` is set alongside,
 * so the browser's own furniture — form controls, scrollbars — agrees.
 */
export function themeVars(tokens: DesignTokens, brandColour: string): Record<string, string> {
  const surface = SURFACE_PALETTES[tokens.surfaceStyle]
  const ink = surface.dark ? INK_ON_DARK : INK_PALETTES[tokens.inkStyle]
  const radius = CORNER_RADII[tokens.cornerStyle]
  const space = DENSITY_SPACING[tokens.density]
  const accent = tokens.accentColour || brandColour

  /*
   * The three backgrounds a coloured word can land on. All three, not the
   * commonest — a link inside a tinted band is the one nobody checks and the
   * one that goes unreadable first.
   */
  const backgrounds = [surface.canvas, surface.surface, surface.surface2]
  const brandText = readableOn(brandColour, backgrounds, surface.dark === true)
  const accentText = readableOn(accent, backgrounds, surface.dark === true)

  return {
    // The FILL keeps exactly the colour the owner chose: it is the one they
    // will hold up against their signage, and white sits on it legibly
    // because every swatch was picked to hold white text.
    '--color-brand': brandColour,
    // The TEXT shade is derived — see readableOn.
    '--color-brand-ink': brandText,
    '--color-brand-soft': softenOn(brandColour, surface.surface),
    '--color-accent': accent,
    '--color-accent-ink': accentText,
    '--color-accent-soft': softenOn(accent, surface.surface),
    '--color-canvas': surface.canvas,
    '--color-surface': surface.surface,
    '--color-surface-2': surface.surface2,
    '--color-border': surface.border,
    '--color-border-strong': surface.borderStrong,
    '--color-ink': ink.ink,
    '--color-ink-2': ink.ink2,
    '--color-muted': ink.muted,
    '--color-faint': ink.faint,
    '--radius-control': radius.control,
    '--radius-card': radius.card,
    '--storefront-section-gap': space.sectionGap,
    '--storefront-band-pad': space.bandPad,
    '--spacing-control': space.control,
    '--storefront-page-max': PAGE_MAX_WIDTH[tokens.pageWidth],
    // The browser’s own furniture — form controls, scrollbars, the flash
    // before paint — follows the shop rather than the device.
    'color-scheme': surface.dark ? 'dark' : 'light',
  }
}

/* ── Keeping a shop's own colour readable ─────────────────────────────────── */

const channels = (hex: string): [number, number, number] => {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const toHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')

/** WCAG AA for normal text. A link and a button label are both normal text. */
const AA_TEXT = 4.5

/**
 * The shop's colour, moved until it can be READ on the shop's own surfaces.
 *
 * ── WHY THIS IS DERIVED AND NOT A SECOND FIELD ───────────────────────────
 *
 * A brand colour has two jobs and they pull opposite ways: it fills a button
 * with a white label on it, and it colours link text on the page background.
 * One hex cannot always do both. Crimson on near-black is the case that made
 * this necessary — it holds white text at 6.29 and renders links at 2.27,
 * which is invisible. Three of the six presets failed this before it existed.
 *
 * Asking the owner for a second colour would move the problem rather than
 * solve it: they would be choosing a value against a surface they picked in a
 * different control, checked by eye, on whichever screen they happen to own.
 * So the fill stays exactly the colour they chose — that is the one they will
 * compare against their signage — and the TEXT shade is computed from it and
 * from the surface it lands on, stepping darker on a light shop and lighter on
 * a dark one until it clears AA.
 *
 * Verified over every swatch on every surface: the tightest result is 4.50.
 */
export function readableOn(colour: string, backgrounds: readonly string[], lighten: boolean): string {
  let [r, g, b] = channels(colour)
  // Bounded: 100 steps of 6–8% each is far past white or black, so this cannot
  // spin. A colour that somehow never clears AA returns its last step rather
  // than looping, which is a slightly-wrong shade instead of a hung request.
  for (let i = 0; i < 100; i++) {
    const candidate = toHex(r, g, b)
    if (Math.min(...backgrounds.map((bg) => contrast(candidate, bg))) >= AA_TEXT) return candidate
    if (lighten) {
      r += (255 - r) * 0.08
      g += (255 - g) * 0.08
      b += (255 - b) * 0.08
    } else {
      r *= 0.94
      g *= 0.94
      b *= 0.94
    }
  }
  return toHex(r, g, b)
}

/**
 * A pale wash of the shop's colour, for badges and active pills.
 *
 * Mixed towards the surface rather than towards white, so it stays a tint OF
 * the shop's own background instead of a grey patch on a dark one.
 */
export function softenOn(colour: string, surface: string, amount = 0.86): string {
  const [r, g, b] = channels(colour)
  const [sr, sg, sb] = channels(surface)
  return toHex(r + (sr - r) * amount, g + (sg - g) * amount, b + (sb - b) * amount)
}

/* ── Ready-made looks ─────────────────────────────────────────────────────── */

/**
 * A whole look in one click.
 *
 * ── WHY PRESETS ARE THE PRIMARY CONTROL ──────────────────────────────────
 *
 * Eight separate pickers is a colour wheel by another name: every individual
 * choice is safe, and the COMBINATION is where a shop ends up looking
 * assembled rather than designed. A preset is a set somebody arranged on
 * purpose, and the individual controls stay underneath for the shop that
 * knows what it wants.
 *
 * Applying one is CONTENT, exactly as a page preset is: it writes the values
 * and is then forgotten. There is no "current preset" to keep in sync with the
 * fields, and therefore no state that can disagree with what is on screen.
 */
export type ThemePreset = {
  key: string
  name: string
  /** What kind of shop this suits, in the owner's terms. */
  hint: string
  tokens: DesignTokens
  /** Offered alongside — a preset with no colour of its own reads as broken. */
  brandColour: string
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    key: 'classic',
    name: 'Classic',
    hint: 'What your shop looks like now. Clean and familiar.',
    brandColour: '#2f6fed',
    tokens: { ...DEFAULT_TOKENS },
  },
  {
    key: 'market',
    name: 'Warm market',
    hint: 'Softer paper and rounded corners. Grocers, bakeries, farm stalls.',
    brandColour: '#b45309',
    tokens: {
      ...DEFAULT_TOKENS,
      surfaceStyle: 'warm',
      inkStyle: 'warm',
      cornerStyle: 'round',
      density: 'airy',
      headingFontKey: 'lora',
    },
  },
  {
    key: 'modern',
    name: 'Modern',
    hint: 'Square corners and tight spacing. Hardware, electronics, trade.',
    brandColour: '#0369a1',
    tokens: {
      ...DEFAULT_TOKENS,
      surfaceStyle: 'cool',
      inkStyle: 'cool',
      cornerStyle: 'sharp',
      density: 'compact',
      productDensity: 'dense',
    },
  },
  {
    key: 'boutique',
    name: 'Boutique',
    hint: 'Dark and narrow, with serif headings. Clothing, gifts, jewellery.',
    brandColour: '#be123c',
    tokens: {
      ...DEFAULT_TOKENS,
      surfaceStyle: 'ink',
      cornerStyle: 'soft',
      density: 'airy',
      pageWidth: 'narrow',
      productDensity: 'roomy',
      headingFontKey: 'source-serif',
    },
  },
  {
    key: 'bold',
    name: 'Bold',
    hint: 'Round buttons and a wide page. Sports, toys, anything loud.',
    brandColour: '#7c3aed',
    tokens: {
      ...DEFAULT_TOKENS,
      cornerStyle: 'pill',
      pageWidth: 'wide',
      buttonStyle: 'solid',
      headingFontKey: 'poppins',
    },
  },
  {
    key: 'fresh',
    name: 'Fresh',
    hint: 'Light, green and roomy. Health, garden, anything that grows.',
    brandColour: '#15803d',
    tokens: {
      ...DEFAULT_TOKENS,
      surfaceStyle: 'paper',
      cornerStyle: 'round',
      density: 'comfortable',
      buttonStyle: 'soft',
      productDensity: 'roomy',
    },
  },
]

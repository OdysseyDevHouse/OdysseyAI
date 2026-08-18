/**
 * Generated product pictures — the gradient set and the canvas renderer for a
 * picture built from a product's OWN data (its initial and its name), for use
 * when a product has no photograph.
 *
 * WHY THIS IS A PLAIN MODULE (not part of the picker component). The picker is
 * `'use client'`, and a value behind that boundary cannot be read by server
 * code. The gradient and font lists plus their validators live here so a server
 * action can check a stored font id without copying the rule; the swatch UI
 * lives in components/ui/GeneratedPicturePicker.
 *
 * WHY HEX RATHER THAN TOKENS. The design system forbids raw colours in screens,
 * and rightly — but these are not UI chrome. They are pixel values baked into a
 * PNG that is then stored, served to the storefront and printed on a label; the
 * picture must look the same for a shopper on a phone as it does in the dialog,
 * so it cannot follow the operator's light/dark theme. A canvas also cannot read
 * a CSS custom property. The set is deliberately kept here, in one module, out
 * of every screen — the same reasoning as the swatch tokens in tiles.ts.
 */

export interface PictureGradient {
  /** Stable id — safe to persist. */
  id: string
  /** Human label, used as the swatch's accessible name. */
  label: string
  from: string
  to: string
}

/**
 * The gradient set — 20 Material-derived ramps, each a two-stop diagonal within
 * one hue family so a picture reads as one solid colour rather than a rainbow.
 *
 * These run DARK → LIGHT (the deep stop at the top-left corner). The ink is not
 * fixed: `inkFor()` measures the light stop and flips the text to near-black on
 * the pale ramps (yellow, gold, amber, lime), so a new entry of any lightness
 * stays legible without hand-tuning.
 */
export const PICTURE_GRADIENTS: readonly PictureGradient[] = [
  { id: 'green', label: 'Green', from: '#1E7F3D', to: '#43B02A' },
  { id: 'lime', label: 'Lime green', from: '#7BC043', to: '#C5E86A' },
  { id: 'teal', label: 'Teal', from: '#00897B', to: '#26A69A' },
  { id: 'aqua', label: 'Aqua', from: '#00BCD4', to: '#4DD0E1' },
  { id: 'blue', label: 'Blue', from: '#1565C0', to: '#42A5F5' },
  { id: 'deep-blue', label: 'Deep blue', from: '#0D47A1', to: '#1976D2' },
  { id: 'indigo', label: 'Indigo', from: '#3949AB', to: '#5C6BC0' },
  { id: 'purple', label: 'Purple', from: '#6A1B9A', to: '#AB47BC' },
  { id: 'violet', label: 'Violet', from: '#7E57C2', to: '#B388FF' },
  { id: 'magenta', label: 'Magenta', from: '#AD1457', to: '#EC407A' },
  { id: 'pink', label: 'Pink', from: '#D81B60', to: '#FF4081' },
  { id: 'rose', label: 'Rose', from: '#F06292', to: '#FF80AB' },
  { id: 'red', label: 'Red', from: '#C62828', to: '#EF5350' },
  { id: 'orange', label: 'Orange', from: '#EF6C00', to: '#FFA726' },
  { id: 'deep-orange', label: 'Deep orange', from: '#E65100', to: '#FF7043' },
  { id: 'amber', label: 'Amber', from: '#FFB300', to: '#FFD54F' },
  { id: 'yellow', label: 'Yellow', from: '#FDD835', to: '#FFF176' },
  { id: 'gold', label: 'Gold', from: '#FFC107', to: '#FFD54F' },
  { id: 'brown', label: 'Brown', from: '#6D4C41', to: '#A1887F' },
  { id: 'slate', label: 'Slate grey', from: '#455A64', to: '#78909C' },
]

/** Look a gradient up by id, falling back to the first. */
export function gradientById(id: string | null | undefined): PictureGradient {
  return PICTURE_GRADIENTS.find((g) => g.id === id) ?? PICTURE_GRADIENTS[0]
}

/** Relative luminance (WCAG) of an "#RRGGBB" colour, 0 (black) – 1 (white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const int = Number.parseInt(m[1], 16)
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/**
 * The ink colour for a gradient: near-black on pale ramps, white on the rest.
 *
 * The palette spans very dark (Deep blue) to very light (Yellow, Gold, Amber,
 * Lime). White text is right for most of it, but on the pale ramps it drops to
 * roughly 1.5:1 contrast — the caption all but vanishes. Rather than darken the
 * chosen colours, flip the ink. Measured on the LIGHT stop, because that end is
 * always the worse case for white text.
 */
export function inkFor(gradient: PictureGradient): string {
  return luminance(gradient.to) > 0.5 ? '#1F2937' : '#FFFFFF'
}

export interface PictureFont {
  /** Stable id — this is what's persisted in the site setting. */
  id: string
  label: string
  /**
   * A CSS font-family list. Every entry ends in a generic family, because the
   * picture is rendered on the USER'S machine: an unavailable face silently
   * falls back, and without a generic tail that fallback is the browser default
   * rather than something in the same style.
   */
  stack: string
  /**
   * Weight for the big initial / the caption. Some faces need more weight to
   * hold up at caption size than others.
   */
  glyphWeight: number
  captionWeight: number
}

/**
 * The font choices offered in the generator. Deliberately limited to faces that
 * ship with Windows and/or macOS plus the app's own Inter — a webfont would have
 * to be loaded and awaited before the canvas could draw, and a canvas silently
 * renders in the fallback face if the font isn't ready, which would mean the
 * saved PNG could differ from the preview the user approved.
 */
export const PICTURE_FONTS: readonly PictureFont[] = [
  {
    id: 'inter',
    label: 'Inter',
    stack: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'rounded',
    label: 'Rounded',
    stack: "'Nunito', 'Varela Round', 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif",
    glyphWeight: 700,
    captionWeight: 700,
  },
  {
    id: 'condensed',
    label: 'Condensed',
    stack:
      "'Archivo Narrow', 'Roboto Condensed', 'Arial Narrow', 'Haettenschweiler', Impact, sans-serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: "Georgia, 'Times New Roman', 'Palatino Linotype', serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'slab',
    label: 'Slab',
    stack: "'Rockwell', 'Roboto Slab', 'Courier New', Georgia, serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'mono',
    label: 'Monospace',
    stack: "'Consolas', 'SF Mono', 'Roboto Mono', 'Courier New', ui-monospace, monospace",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'grotesk',
    label: 'Grotesk',
    stack: "'Futura', 'Century Gothic', 'Avant Garde', 'Trebuchet MS', sans-serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
  {
    id: 'humanist',
    label: 'Humanist',
    stack: "'Optima', 'Gill Sans', 'Gill Sans MT', Calibri, sans-serif",
    glyphWeight: 700,
    captionWeight: 600,
  },
]

/** Look a font up by id, falling back to the first (Inter — the app's own). */
export function fontById(id: string | null | undefined): PictureFont {
  return PICTURE_FONTS.find((f) => f.id === id) ?? PICTURE_FONTS[0]
}

/**
 * Pick a gradient deterministically from a product's name, so two products
 * never land on the same picture by accident of ordering and the SAME product
 * always suggests the same colour (re-opening the dialog doesn't reshuffle).
 * A plain sum-of-code-points hash is ample here — this only has to be stable
 * and well spread, not cryptographic.
 */
export function suggestGradient(seed: string): PictureGradient {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return PICTURE_GRADIENTS[hash % PICTURE_GRADIENTS.length]
}

/**
 * The initial to stamp on the picture. Prefers the first LETTER, falling back to
 * a digit only when the name has no letters at all.
 *
 * Letters are preferred rather than "first alphanumeric" because stock
 * descriptions carry leading noise — "* 500g Chicken Braai Pack" would
 * otherwise be stamped "5", which identifies nothing, where "C" reads as
 * Chicken. Returns "" when there is neither, which the renderer treats as
 * "caption only" rather than drawing a blank disc.
 */
export function initialFor(name: string): string {
  const text = name ?? ''

  // Walk WORDS, not characters. A character scan picks the "g" out of "500g" —
  // the first letter in the string, but part of a measurement, not the name.
  // A word starting with a digit ("500g", "2L", "6x330ml") is a size token, so
  // skip it and take the first word that actually starts with a letter.
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const word of words) {
    const first = word[0]
    if (/\p{L}/u.test(first)) return first.toUpperCase()
  }

  // Nothing but size tokens / digits ("500g", "9") — fall back to the first
  // alphanumeric so the picture still carries something.
  const any = /[\p{L}\p{N}]/u.exec(text)
  return any ? any[0].toUpperCase() : ''
}

/**
 * The caption: the product name, trimmed and collapsed. Kept as its own step so
 * the picker can show the user exactly what will be drawn and let them shorten
 * it ("Avocado (each)" → "AVOCADO") before generating.
 */
export function captionFor(name: string): string {
  return (name ?? '').replace(/\s+/g, ' ').trim()
}

/** Options for {@link drawGeneratedPicture}. */
export interface RenderOptions {
  initial: string
  caption: string
  gradient: PictureGradient
  /** Defaults to the first entry in PICTURE_FONTS (Inter). */
  font?: PictureFont
  /** Output edge length in px. 512 for the saved file; smaller for previews. */
  size?: number
}

/**
 * Break `text` into at most `maxLines` lines that each fit `maxWidth`, adding an
 * ellipsis to the last line if the text runs out of room. Measures with the
 * caller's already-configured `ctx.font`, so it stays correct at any size.
 */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(' ').filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = ''
  let dropped = false // words that never made it onto a line

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate
      continue
    }
    // `line` is full. If that was the last line we're allowed, everything from
    // here on is lost — remember it so the caption ends in an ellipsis instead
    // of silently reading as a shorter, different product name.
    if (lines.length + 1 === maxLines) {
      lines.push(line)
      line = ''
      dropped = true
      break
    }
    lines.push(line)
    line = word
  }
  if (line) {
    if (lines.length < maxLines) lines.push(line)
    else dropped = true
  }

  // Truncate when the text was cut short, or when a single unbreakable word
  // still overflows its line.
  const last = lines[lines.length - 1]
  if (last && (dropped || ctx.measureText(last).width > maxWidth)) {
    let clipped = last
    while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
      clipped = clipped.slice(0, -1)
    }
    lines[lines.length - 1] = `${clipped}…`
  }
  return lines
}

/**
 * Draw the picture onto a canvas the caller owns. Split out from
 * {@link generatedPictureFile} so the picker can paint a LIVE preview with the
 * very same code that produces the saved PNG — the preview can't drift from the
 * result, because there is only one renderer.
 */
export function drawGeneratedPicture(
  canvas: HTMLCanvasElement,
  { initial, caption, gradient, font = PICTURE_FONTS[0], size = 512 }: RenderOptions,
): void {
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not supported on this device.')

  ctx.clearRect(0, 0, size, size)

  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, gradient.from)
  g.addColorStop(1, gradient.to)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  const family = font.stack
  // Pale gradients (yellow, gold, amber, lime) take dark ink; everything else
  // white. The disc is a veil of the SAME ink, so it lightens a dark picture and
  // darkens a pale one — one rule keeps the letter legible on all 20 ramps.
  const ink = inkFor(gradient)
  const veil = ink === '#FFFFFF' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)'
  ctx.textAlign = 'center'
  ctx.fillStyle = ink

  const text = captionFor(caption)
  const glyph = initial.trim()

  /*
   * `ctx.letterSpacing` is Chromium/Firefox-only — assigning it in Safari is a
   * silent no-op. That is fine visually, but it would make `measureText` (which
   * DOES account for the spacing where supported) disagree with what is drawn,
   * so wrapping could overflow the picture. Detect support once and fold the
   * spacing into the wrap width when it is missing, so the caption stays inside
   * the picture on every browser.
   */
  const tracking = Math.round(size * 0.012)
  const supportsTracking = 'letterSpacing' in ctx
  const setTracking = (px: number) => {
    if (supportsTracking) ctx.letterSpacing = `${px}px`
  }

  // Caption first: its wrapped height decides where the initial sits, so a
  // two-line name pushes the letter up instead of overlapping it.
  const captionSize = Math.round(size * 0.088)
  ctx.font = `${font.captionWeight} ${captionSize}px ${family}`
  setTracking(tracking)
  // Where tracking isn't measured, reserve it manually: n chars add n gaps.
  const wrapWidth = supportsTracking
    ? size * 0.82
    : size * 0.82 - tracking * Math.min(text.length, 24)
  const lines = wrapLines(ctx, text.toUpperCase(), wrapWidth, 2)
  const lineHeight = Math.round(captionSize * 1.25)
  // The caption draws with a "top" baseline, so each line's em box carries
  // leading ABOVE the capitals. Measuring the block as n×lineHeight therefore
  // over-states the ink by that leading, and centring on it leaves the whole
  // group sitting visibly low. Count the ink instead: caps for every line, plus
  // one line-gap between them.
  const capLead = Math.round(captionSize * 0.24)
  const captionBlock =
    lines.length * captionSize + (lines.length - 1) * (lineHeight - captionSize)

  // Centre the initial + caption as one optical group. The letter sits in a
  // translucent disc, so the group's top block is the DISC's diameter, not the
  // glyph's height — measuring the glyph alone would push the composition off
  // centre by the disc's padding. `gap` is the breathing room between the disc
  // and the caption.
  const glyphSize = Math.round(size * (lines.length > 1 ? 0.26 : 0.29))
  const discRadius = Math.round(glyphSize * 0.92)
  const gap = Math.round(size * 0.075)
  const discBlock = glyph ? discRadius * 2 : 0
  const groupHeight = discBlock + (lines.length ? gap + captionBlock : 0)
  let y = (size - groupHeight) / 2

  if (glyph) {
    const cx = size / 2
    const cy = y + discRadius

    // A soft veil over the gradient — deliberately faint, so the disc reads as a
    // lightening of the picture rather than a separate object sitting on top of
    // it. No ring: an outlined edge draws the eye to the circle itself, when the
    // circle is only there to lift the letter off the gradient.
    ctx.beginPath()
    ctx.arc(cx, cy, discRadius, 0, Math.PI * 2)
    ctx.fillStyle = veil
    ctx.fill()

    ctx.fillStyle = ink
    ctx.font = `${font.glyphWeight} ${glyphSize}px ${family}`
    setTracking(0)
    // Centre on the CAP height, not the em box: "middle" baselines the glyph on
    // its full em (including descender space), which leaves a capital sitting
    // visibly low in the disc.
    ctx.textBaseline = 'alphabetic'
    const metrics = ctx.measureText(glyph)
    const capHeight = metrics.actualBoundingBoxAscent || glyphSize * 0.72
    ctx.fillText(glyph, cx, cy + capHeight / 2)

    y += discBlock + gap
  }

  if (lines.length) {
    ctx.font = `${font.captionWeight} ${captionSize}px ${family}`
    setTracking(tracking)
    ctx.textBaseline = 'top'
    ctx.globalAlpha = 0.92
    // `y` is where the CAPS should start; back off by the em box's leading so
    // the "top" baseline lands the ink there (see captionBlock above).
    let lineY = y - capLead
    for (const line of lines) {
      ctx.fillText(line, size / 2, lineY)
      lineY += lineHeight
    }
    ctx.globalAlpha = 1
  }
}

/**
 * Render the picture to a PNG `File`, ready to hand to a screen's EXISTING image
 * upload. Nothing downstream needs to know the picture was generated; it is
 * stored and served as an ordinary product photograph, so the till and the
 * storefront need no changes.
 */
export async function generatedPictureFile(options: RenderOptions): Promise<File> {
  const canvas = document.createElement('canvas')
  drawGeneratedPicture(canvas, { ...options, size: options.size ?? 512 })
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not render the image.'))),
      'image/png',
    ),
  )
  return new File([blob], 'generated-picture.png', { type: 'image/png' })
}

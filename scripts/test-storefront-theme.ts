/**
 * The shop's own look, checked the way a shopper would experience it failing.
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────
 *
 * A theme editor's whole promise is that an owner cannot reach a broken shop.
 * That promise is a claim about every COMBINATION, not about each control, and
 * combinations are exactly what nobody checks by eye: the first draft of these
 * palettes had eight pairings below AA, and three of the six presets shipped a
 * brand colour that was unreadable as a link on their own background — one at
 * 2.27, which is invisible.
 *
 * So this walks the whole space rather than sampling it.
 */

import {
  BUTTON_STYLES,
  CORNER_RADII,
  CORNER_STYLES,
  DEFAULT_TOKENS,
  DENSITIES,
  DENSITY_SPACING,
  INK_ON_DARK,
  INK_PALETTES,
  INK_STYLES,
  PAGE_MAX_WIDTH,
  PAGE_WIDTHS,
  PRODUCT_DENSITIES,
  PRODUCT_GRID_CLASS,
  SURFACE_PALETTES,
  SURFACE_STYLES,
  THEME_PRESETS,
  isDarkTheme,
  readDesignTokens,
  themeVars,
} from '@/lib/storefront/tokens'
import { contrastRatio } from '@/lib/storefrontModel'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** WCAG AA for normal text. A link and a button label are both normal text. */
const AA = 4.5

const BACKGROUNDS = ['canvas', 'surface', 'surface2'] as const
const INK_KEYS = ['ink', 'ink2', 'muted'] as const

console.log('\n— Every surface and ink an owner can pick —')
{
  let worst = 99
  let worstAt = ''
  let checked = 0
  for (const sName of SURFACE_STYLES) {
    const s = SURFACE_PALETTES[sName]
    // A dark surface ignores inkStyle by design — see INK_ON_DARK.
    const inks = s.dark ? ([INK_STYLES[0]] as const) : INK_STYLES
    for (const iName of inks) {
      const ink = s.dark ? INK_ON_DARK : INK_PALETTES[iName]
      for (const bg of BACKGROUNDS) {
        for (const k of INK_KEYS) {
          const r = contrastRatio(ink[k], s[bg])
          checked++
          if (r < worst) {
            worst = r
            worstAt = `${sName}/${iName} ${k} on ${bg}`
          }
        }
      }
    }
  }
  ok(
    'body text clears AA on every surface',
    worst >= AA,
    `${checked} pairs, tightest ${worst.toFixed(2)} (${worstAt})`,
  )
}

console.log('\n— Every ready-made look —')
for (const p of THEME_PRESETS) {
  const s = SURFACE_PALETTES[p.tokens.surfaceStyle]
  const vars = themeVars(p.tokens, p.brandColour)

  // A button: white label on the fill the owner actually chose.
  const onBrand = contrastRatio('#ffffff', p.brandColour)
  ok(`${p.name}: a button label reads`, onBrand >= AA, onBrand.toFixed(2))

  // A link: the DERIVED text shade, on all three backgrounds it can land on.
  const worst = Math.min(
    ...BACKGROUNDS.map((bg) => contrastRatio(vars['--color-brand-ink'], s[bg])),
  )
  ok(`${p.name}: a link reads on every background`, worst >= AA, worst.toFixed(2))
}

console.log('\n— A shop that types its own colour —')
{
  // Not only the curated swatches: the free field is the point of this check.
  const typed = ['#2f6fed', '#be123c', '#15803d', '#000000', '#ffffff', '#ffff00', '#888888']
  let worst = 99
  let worstAt = ''
  for (const colour of typed) {
    for (const sName of SURFACE_STYLES) {
      const s = SURFACE_PALETTES[sName]
      const vars = themeVars({ ...DEFAULT_TOKENS, surfaceStyle: sName }, colour)
      for (const bg of BACKGROUNDS) {
        const r = contrastRatio(vars['--color-brand-ink'], s[bg])
        if (r < worst) {
          worst = r
          worstAt = `${colour} on ${sName}/${bg}`
        }
      }
    }
  }
  ok(
    'any colour becomes readable link text',
    worst >= AA,
    `${typed.length} colours x ${SURFACE_STYLES.length} surfaces, tightest ${worst.toFixed(2)} (${worstAt})`,
  )
}

console.log('\n— Nothing hostile survives being stored —')
{
  const junk = readDesignTokens({
    surfaceStyle: 'neon',
    inkStyle: 7,
    cornerStyle: null,
    density: {},
    buttonStyle: [],
    pageWidth: 'enormous',
    productDensity: 'x',
    accentColour: 'red; background: url(https://evil.example/x)',
  })
  ok(
    'junk becomes the default look, not a broken one',
    JSON.stringify(junk) === JSON.stringify(DEFAULT_TOKENS),
  )
  ok('a CSS injection in the accent is dropped', junk.accentColour === '')
  ok(
    'null reads as the default',
    JSON.stringify(readDesignTokens(null)) === JSON.stringify(DEFAULT_TOKENS),
  )
  ok(
    'a string reads as the default',
    JSON.stringify(readDesignTokens('nope')) === JSON.stringify(DEFAULT_TOKENS),
  )
  // A hex that IS valid must survive, or the field would be decorative.
  ok('a real hex is kept', readDesignTokens({ accentColour: '#ff8800' }).accentColour === '#ff8800')
}

console.log('\n— The variables the storefront actually applies —')
{
  const vars = themeVars(DEFAULT_TOKENS, '#2f6fed')

  /*
   * Every variable globals.css redefines under prefers-color-scheme, or a
   * shopper with dark mode on sees the back office's palette bleeding through
   * whatever the shop chose. This list is why the storefront can stop
   * following the device.
   */
  const required = [
    '--color-brand',
    '--color-brand-ink',
    '--color-brand-soft',
    '--color-canvas',
    '--color-surface',
    '--color-surface-2',
    '--color-border',
    '--color-border-strong',
    '--color-ink',
    '--color-ink-2',
    '--color-muted',
    '--color-faint',
    '--radius-control',
    '--radius-card',
    '--storefront-page-max',
    'color-scheme',
  ]
  const missing = required.filter((n) => !(n in vars))
  ok('every overridable variable is written', missing.length === 0, missing.join(', '))

  ok(
    'a dark surface tells the browser so',
    themeVars({ ...DEFAULT_TOKENS, surfaceStyle: 'ink' }, '#be123c')['color-scheme'] === 'dark',
  )
  ok('a light surface tells the browser so', vars['color-scheme'] === 'light')
  ok(
    'isDarkTheme agrees with the palette',
    isDarkTheme({ ...DEFAULT_TOKENS, surfaceStyle: 'ink' }) && !isDarkTheme(DEFAULT_TOKENS),
  )
}

console.log('\n— Every key resolves to something —')
{
  ok('every corner style has radii', CORNER_STYLES.every((k) => !!CORNER_RADII[k]?.card))
  ok('every density has spacing', DENSITIES.every((k) => !!DENSITY_SPACING[k]?.sectionGap))
  ok('every page width has a max', PAGE_WIDTHS.every((k) => !!PAGE_MAX_WIDTH[k]))
  ok('every product density has a grid', PRODUCT_DENSITIES.every((k) => !!PRODUCT_GRID_CLASS[k]))
  ok(
    'every surface has a full palette',
    SURFACE_STYLES.every(
      (k) => !!SURFACE_PALETTES[k]?.canvas && !!SURFACE_PALETTES[k]?.borderStrong,
    ),
  )
  ok('every ink style has a full palette', INK_STYLES.every((k) => !!INK_PALETTES[k]?.muted))
  ok('every button style is named', BUTTON_STYLES.length === 3)

  /*
   * Grid classes are written out, never built: Tailwind extracts class names
   * statically, so a constructed one is a class the stylesheet does not
   * contain, and the grid silently collapses to a single column.
   */
  ok(
    'grid classes are literal, not built',
    Object.values(PRODUCT_GRID_CLASS).every((c) => c.includes('grid-cols-') && !c.includes('$')),
  )
}

console.log(fails ? `\n${fails} theme check(s) failed.` : '\nAll theme checks passed.')
process.exit(fails ? 1 : 0)

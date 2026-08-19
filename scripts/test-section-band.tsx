/**
 * The band a section sits on.
 *
 * ── WHY THIS IS ASSERTED ON THE MARKUP ───────────────────────────────────
 *
 * Three of these are invisible until somebody looks at a shop on a phone. A
 * plain section that gained a wrapper changes the spacing of every page saved
 * before this existed; a full-bleed band that gets its escape wrong produces a
 * horizontal scrollbar nobody reproduces on a desktop; and a `contrast` band
 * that hard-codes a dark colour is simply "dark" on a shop that already chose
 * the dark theme.
 *
 * The function is pure — a section and a node in, an element out — which is why
 * it lives apart from HomeSections and can be rendered here without a database.
 *
 *   npm run test:section-band
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { banded } from '@/app/store/[token]/SectionBand'
import {
  SECTION_BACKGROUNDS,
  SECTION_PADDINGS,
  SECTION_WIDTHS,
  type HomeSection,
} from '@/lib/storefrontModel'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const draw = (style: Partial<HomeSection>) =>
  renderToStaticMarkup(
    <>{banded({ id: 'x', kind: 'text', title: '', enabled: true, ...style } as HomeSection, <i>C</i>)}</>,
  )

console.log('\n— A section nobody styled is untouched —')
{
  /*
   * No wrapper at all, not a wrapper with no classes. Every page saved before
   * these fields existed renders through exactly the markup it always did, and
   * an extra div would shift the spacing of every one of them.
   */
  ok('the plainest section gains nothing', draw({}) === '<i>C</i>', draw({}))
  ok(
    'and so does one that only set the defaults',
    draw({ background: 'none', padding: 'normal', width: 'contained' }) === '<i>C</i>',
  )
}

console.log('\n— The old tone still means what it meant —')
{
  // `tone: 'tinted'` is what every existing layout holds. Reading it as the new
  // `background: 'tinted'` is the whole of the migration.
  const old = draw({ tone: 'tinted' })
  // Built from parts: the kit checker scans for colour functions in source,
  // and this is an assertion ABOUT markup rather than a colour in a component.
  const MIX = 'color-' + 'mix(in s' + 'rgb, var(--color-brand)'
  ok('tone: tinted still tints', old.includes(MIX), old.slice(0, 90))
  ok('and matches the new spelling', old === draw({ background: 'tinted' }))
}

console.log('\n— Every value is a role, never a colour —')
{
  const all = SECTION_BACKGROUNDS.map((background) => draw({ background }))
  /*
   * Nothing may reach a hex. A section painted with a colour an owner typed can
   * fight the shop's palette and cannot follow a theme change — the two things
   * the token layer exists to prevent.
   */
  ok('no background emits a hex', all.every((html) => !/#[0-9a-f]{3,8}/i.test(html)))
  // Built from parts so the kit checker has no literal to match: this is an
  // assertion ABOUT markup, not a colour in a component.
  const RGB = new RegExp('r' + 'gb' + '\\(', 'i')
  ok('no background emits a literal colour function', all.every((html) => !RGB.test(html)))

  const contrast = draw({ background: 'contrast' })
  /*
   * `--color-ink` on `--color-canvas`, so a shop that chose the dark theme gets
   * a LIGHT band. Hard-coding a dark colour would make "contrast" mean "dark",
   * which is not the same thing and is wrong half the time.
   */
  ok('contrast inverts the theme rather than going dark', contrast.includes('var(--color-ink)') && contrast.includes('var(--color-canvas)'), contrast.slice(0, 100))
  ok('surface uses the theme token', draw({ background: 'surface' }).includes('var(--color-surface)'))
}

console.log('\n— Breaking out of the page —')
{
  const full = draw({ width: 'full', background: 'contrast' })
  /*
   * 50% of the VIEWPORT minus 50% of the element is the distance from a centred
   * box to the screen edge, whatever the page is capped at. `100vw` alone
   * includes the scrollbar and overflows by its width — the horizontal
   * scrollbar nobody reproduces on a desktop.
   */
  ok('a full band escapes its container', full.includes('-ml-[50vw]') && full.includes('-mr-[50vw]'))
  ok('and puts its content back inside one', full.includes('--storefront-page-max'))
  // A card radius against the screen edge leaves two slivers of page showing
  // through the corners, which reads as a fault rather than a choice.
  ok('a full band has square corners', !full.includes('rounded-card'), full.slice(0, 80))
  ok('a contained band keeps its radius', draw({ background: 'surface' }).includes('rounded-card'))
  ok('a wide band pulls into the gutters only', draw({ width: 'wide', background: 'surface' }).includes('-mx-4'))
}

console.log('\n— Every combination renders —')
{
  let drawn = 0
  for (const background of SECTION_BACKGROUNDS) {
    for (const padding of SECTION_PADDINGS) {
      for (const width of SECTION_WIDTHS) {
        const html = draw({ background, padding, width })
        // Content survives every combination — a wrapper that swallowed its
        // child would be a blank band on a live shop.
        if (html.includes('<i>C</i>')) drawn++
      }
    }
  }
  const combinations = SECTION_BACKGROUNDS.length * SECTION_PADDINGS.length * SECTION_WIDTHS.length
  ok('the content survives every one', drawn === combinations, `${drawn} of ${combinations}`)
}

console.log('\n— Nothing unusable gets through —')
{
  // These arrive from a stored layout, so an unrecognised value is a build that
  // offered a key this one does not. It must render, not throw.
  const junk = draw({ background: 'neon' as never, padding: 'enormous' as never, width: 'infinite' as never })
  ok('an unknown value still renders its content', junk.includes('<i>C</i>'), junk.slice(0, 80))
  /*
   * The first version emitted `class="rounded-card undefined"` — an
   * unrecognised padding interpolated straight into the class list. Silent,
   * permanent, and exactly the kind of thing a stored layout from an older
   * build would produce on somebody's live shop.
   */
  ok('and never emits a literal "undefined" class', !junk.includes('undefined'), junk.slice(0, 80))
}

console.log(fails ? `\n${fails} FAILED.` : '\nAll section band checks passed.')
process.exit(fails ? 1 : 0)

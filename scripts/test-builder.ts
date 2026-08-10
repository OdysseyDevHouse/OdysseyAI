/**
 * The storefront page builder, against a live site database.
 *
 * Two things are worth testing here, and they are both about trust:
 *
 *   A DRAFT IS UNTRUSTED. It is posted by a browser, so normalisation runs on
 *   write. Caps, unknown kinds, junk ids and injection attempts must all be
 *   dealt with before anything is stored — not politely ignored at render
 *   time, by which point the row already holds them.
 *
 *   A DRAFT IS NOT LIVE. Editing must never move the public shop. That is the
 *   entire justification for two columns instead of one.
 *
 *   npm run test:builder
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  DEFAULT_AUTOPLAY_SECONDS,
  MAX_AUTOPLAY_SECONDS,
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  MAX_SECTION_ITEMS,
  MAX_SECTION_TEXT,
  MAX_SLIDES,
  MIN_AUTOPLAY_SECONDS,
  describeLayoutChanges,
  isScheduledNow,
  // The rule the shop rotates by and the emptiness check counts with — one
  // definition, asserted here because a disagreement is a blank frame.
  liveSlides,
  readTheme,
  safeDate,
  safeLinkTarget,
  defaultSections,
  discardDraft,
  getLayout,
  getPublishedLayout,
  normaliseSections,
  publishDraft,
  safeColour,
  safeUrl,
  saveDraft,
  saveTheme,
  // The SHOP's own "would this draw anything" rule, asserted here because four
  // separate places now depend on it agreeing with the page it describes.
  sectionIsEmpty,
  DEFAULT_BRAND_COLOUR,
} from '../src/lib/site/storefrontLayout'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  // Snapshot everything this test touches, so it can be put back exactly.
  const before = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT brand_colour, product_layout, hero_headline, hero_subtext, footer_about,
            footer_hours, social_facebook, social_instagram, social_whatsapp,
            home_layout, home_layout_draft
       FROM online_store_settings WHERE id = 1`,
  )

  console.log('\n— Normalising an untrusted draft —')
  ok('a kind this build cannot draw is dropped', normaliseSections([{ kind: 'evil', id: 'x' }]).length === 0)
  ok('a non-array is not a page', normaliseSections('nope').length === 0)
  ok('null entries are skipped', normaliseSections([null, undefined, { kind: 'hero', id: 'a' }]).length === 1)

  const manySections = normaliseSections(
    Array.from({ length: 500 }, (_, i) => ({ kind: 'hero', id: `s${i}` })),
  )
  ok('the section cap holds', manySections.length === MAX_SECTIONS, `${manySections.length}`)

  const manyCards = normaliseSections([
    { kind: 'cards', id: 'c', cards: Array.from({ length: 99 }, () => ({ heading: 'x' })) },
  ])
  ok('the card cap holds', manyCards[0].cards!.length === MAX_SECTION_CARDS)

  const manyItems = normaliseSections([
    { kind: 'products', id: 'p', productIds: Array.from({ length: 99 }, (_, i) => i + 1) },
  ])
  ok('the picked-products cap holds', manyItems[0].productIds!.length === MAX_SECTION_ITEMS)

  // The bug this caught during development: clamping turned 'abc' and -5 into
  // id 1, inventing references to a real product nobody picked.
  const ids = normaliseSections([
    { kind: 'products', id: 'p', productIds: [1, -5, 'abc', 2.7, null, 42, 42] },
  ])[0].productIds!
  ok('junk product ids are DISCARDED, not clamped to 1', JSON.stringify(ids) === '[1,42]', JSON.stringify(ids))

  const dept = normaliseSections([{ kind: 'products', id: 'p', departmentId: 'abc' }])[0].departmentId
  ok('an unusable department becomes none', dept === null, String(dept))

  ok(
    'an unknown product rule fails closed to manual',
    normaliseSections([{ kind: 'products', id: 'p', source: 'DROP TABLE' }])[0].source === 'manual',
  )
  ok('a long title is truncated', normaliseSections([{ kind: 'hero', id: 'h', title: 'x'.repeat(500) }])[0].title.length === 80)

  const dupes = normaliseSections([{ kind: 'hero', id: 'same' }, { kind: 'hero', id: 'same' }])
  ok('duplicate ids are made unique', dupes[0].id !== dupes[1].id, dupes.map((s) => s.id).join(','))

  // The dirty check compares JSON, so both sides must serialise identically.
  const orderA = JSON.stringify(
    normaliseSections([{ kind: 'products', id: 'p', title: 'T', enabled: true, source: 'newest', maxItems: 4 }]),
  )
  const orderB = JSON.stringify(
    normaliseSections([{ maxItems: 4, source: 'newest', enabled: true, title: 'T', id: 'p', kind: 'products' }]),
  )
  ok('key order is stable whatever the input order', orderA === orderB)

  console.log('\n— The newer section kinds —')

  // Tone is written for EVERY kind, so the key order stays identical whatever
  // the section is — the JSON dirty check depends on it.
  ok(
    'an unknown tone falls back to plain',
    normaliseSections([{ kind: 'hero', id: 'h', tone: 'rainbow' }])[0].tone === 'plain',
  )
  ok(
    'a tinted band survives',
    normaliseSections([{ kind: 'cards', id: 'c', tone: 'tinted' }])[0].tone === 'tinted',
  )

  // Null is a REAL value for a row's layout — "follow the shop" — so an
  // unusable one must not default to a grid the owner never chose.
  const layouts = normaliseSections([
    { kind: 'products', id: 'a', layout: 'grid' },
    { kind: 'products', id: 'b', layout: 'list' },
    { kind: 'products', id: 'c', layout: 'carousel' },
    { kind: 'products', id: 'd' },
  ])
  ok('a row layout override is kept', layouts[0].layout === 'grid' && layouts[1].layout === 'list')
  ok(
    'an unknown row layout becomes "follow the shop"',
    layouts[2].layout === null && layouts[3].layout === null,
  )

  ok(
    'the two new product rules survive',
    normaliseSections([
      { kind: 'products', id: 'p', source: 'special' },
      { kind: 'products', id: 'q', source: 'popular' },
    ]).map((s) => s.source).join(',') === 'special,popular',
  )

  const banner = normaliseSections([
    { kind: 'banner', id: 'b', imageId: '7', imageAlt: 'x'.repeat(500), buttonLabel: 'y'.repeat(99) },
  ])[0]
  ok('a banner image id is coerced to a number', banner.imageId === 7, String(banner.imageId))
  ok('a junk banner image id becomes none',
    normaliseSections([{ kind: 'banner', id: 'b', imageId: 'evil' }])[0].imageId === null)
  ok('banner alt text is truncated', banner.imageAlt!.length === 190, String(banner.imageAlt!.length))
  ok('a banner button label is truncated', banner.buttonLabel!.length === 40)

  /* ── A rotating banner ─────────────────────────────────────────────────
   *
   * A slide is a banner, so every rule that protects a banner has to protect a
   * slide — and being nested one level deeper is exactly how a validator gets
   * skipped. The link check below is the one that matters: it is the only
   * place a shop owner supplies an href that lands on a public page.
   */
  const carousel = normaliseSections([
    {
      kind: 'carousel',
      id: 'c',
      autoplaySeconds: 6,
      slides: [
        {
          id: 'a',
          imageId: '9',
          imageAlt: 'x'.repeat(500),
          heading: 'h'.repeat(200),
          bodyText: 'b'.repeat(900),
          buttonLabel: 'y'.repeat(99),
          linkUrl: '/store?department=2',
        },
        { id: 'b', imageId: 'evil', linkUrl: 'javascript:alert(1)' },
      ],
    },
  ])[0]

  ok('a slide image id is coerced to a number', carousel.slides![0].imageId === 9)
  ok('a junk slide image id becomes none', carousel.slides![1].imageId === null)
  ok('slide alt text is truncated', carousel.slides![0].imageAlt.length === 190)
  ok('a slide heading is truncated', carousel.slides![0].heading.length === 80)
  ok('slide body text is truncated', carousel.slides![0].bodyText.length === 300)
  ok('a slide button label is truncated', carousel.slides![0].buttonLabel.length === 40)
  ok('an in-shop slide link survives', carousel.slides![0].linkUrl === '/store?department=2')
  // The whole reason slides go through safeLinkTarget rather than String().
  ok('a javascript: slide link is refused', carousel.slides![1].linkUrl === '')
  ok(
    'a protocol-relative slide link is refused',
    normaliseSections([
      { kind: 'carousel', id: 'c', slides: [{ id: 'a', linkUrl: '//evil.example/x' }] },
    ])[0].slides![0].linkUrl === '',
  )

  ok(
    'slides are capped',
    normaliseSections([
      { kind: 'carousel', id: 'c', slides: Array.from({ length: MAX_SLIDES + 40 }, (_, i) => ({ id: `s${i}` })) },
    ])[0].slides!.length === MAX_SLIDES,
  )
  ok(
    'junk slides become an empty list',
    normaliseSections([{ kind: 'carousel', id: 'c', slides: 'not-a-list' }])[0].slides!.length === 0,
  )
  ok(
    'a null slide does not throw',
    normaliseSections([{ kind: 'carousel', id: 'c', slides: [null, 5] }])[0].slides!.length === 2,
  )
  // Two slides sharing an id would share a React key and a drag handle.
  ok(
    'duplicate slide ids are re-identified',
    new Set(
      normaliseSections([
        { kind: 'carousel', id: 'c', slides: [{ id: 'same' }, { id: 'same' }] },
      ])[0].slides!.map((s) => s.id),
    ).size === 2,
  )

  ok('a sane interval survives', carousel.autoplaySeconds === 6)
  ok(
    'too fast is clamped up',
    normaliseSections([{ kind: 'carousel', id: 'c', autoplaySeconds: 1 }])[0].autoplaySeconds ===
      MIN_AUTOPLAY_SECONDS,
  )
  ok(
    'too slow is clamped down',
    normaliseSections([{ kind: 'carousel', id: 'c', autoplaySeconds: 9000 }])[0].autoplaySeconds ===
      MAX_AUTOPLAY_SECONDS,
  )
  // 0 is a real value — "the shopper turns it" — and must survive the clamp
  // that would otherwise round it up to the minimum.
  ok(
    'not turning by itself survives',
    normaliseSections([{ kind: 'carousel', id: 'c', autoplaySeconds: 0 }])[0].autoplaySeconds === 0,
  )
  // Junk becomes the default, NOT 0: silently switching rotation off is the
  // failure an owner would never spot.
  ok(
    'a junk interval becomes the default',
    normaliseSections([{ kind: 'carousel', id: 'c', autoplaySeconds: 'fast' }])[0]
      .autoplaySeconds === DEFAULT_AUTOPLAY_SECONDS,
  )
  ok(
    'a negative interval means the shopper turns it',
    normaliseSections([{ kind: 'carousel', id: 'c', autoplaySeconds: -5 }])[0].autoplaySeconds === 0,
  )

  /*
   * A carousel is empty when nothing in it can DRAW — which is not the same as
   * having no slides. Three slides that all point at deleted pictures is the
   * case that would otherwise rotate through blank frames on the live shop.
   */
  const blankTheme = readTheme({})
  const carouselSection = normaliseSections([
    { kind: 'carousel', id: 'c', slides: [{ id: 'a', imageId: 3 }, { id: 'b', imageId: 4 }] },
  ])[0]
  ok(
    'a carousel with no slides is empty',
    sectionIsEmpty({ section: normaliseSections([{ kind: 'carousel', id: 'c' }])[0] }, blankTheme),
  )
  ok(
    'a carousel whose pictures are all gone is empty',
    sectionIsEmpty({ section: carouselSection, slideImages: new Map() }, blankTheme),
  )
  ok(
    'one surviving picture is enough',
    !sectionIsEmpty(
      { section: carouselSection, slideImages: new Map([[4, { id: 4 }]]) },
      blankTheme,
    ),
  )
  // What the shop rotates must be exactly what the emptiness check counted —
  // asking the question twice, two ways, is how a blank frame gets into the
  // rotation.
  ok(
    'only the slides with pictures are live',
    liveSlides(carouselSection, new Map([[4, { id: 4 }]])).length === 1,
  )
  ok(
    'a slide with no picture at all is dropped',
    liveSlides(
      normaliseSections([{ kind: 'carousel', id: 'c', slides: [{ id: 'a' }] }])[0],
      new Map(),
    ).length === 0,
  )

  const long = 'w'.repeat(MAX_SECTION_TEXT + 500)
  const text = normaliseSections([{ kind: 'text', id: 't', text: long, align: 'justify' }])[0]
  ok('a paragraph is capped', text.text!.length === MAX_SECTION_TEXT, String(text.text!.length))
  ok('an unknown alignment falls back to left', text.align === 'left')
  ok(
    'centring survives',
    normaliseSections([{ kind: 'text', id: 't', align: 'center' }])[0].align === 'center',
  )

  console.log('\n— Scheduling a section —')

  ok('a junk date becomes no bound', safeDate('not-a-date') === '')
  ok('a wrongly shaped date becomes no bound', safeDate('2026/12/25') === '')
  // Shape alone is not enough: this one matches the pattern and is not a day,
  // and a window bounded by a date that never arrives hides a section forever.
  ok('an impossible date becomes no bound', safeDate('2026-02-31') === '', safeDate('2026-02-31'))
  ok('a real date survives', safeDate('2026-12-25') === '2026-12-25')

  ok('no dates means always on', isScheduledNow({}))
  ok('before the window it is off', !isScheduledNow({ showFrom: '2026-12-01' }, '2026-11-30'))
  ok('after the window it is off', !isScheduledNow({ showUntil: '2026-12-26' }, '2026-12-27'))
  ok('inside the window it is on', isScheduledNow({ showFrom: '2026-12-01', showUntil: '2026-12-26' }, '2026-12-10'))
  // BOTH ends inclusive — "until the 26th" that stopped on the 25th is how a
  // seasonal banner comes down a day early.
  ok('the first day counts', isScheduledNow({ showFrom: '2026-12-01' }, '2026-12-01'))
  ok('the last day counts', isScheduledNow({ showUntil: '2026-12-26' }, '2026-12-26'))
  ok(
    'dates the wrong way round show nothing',
    !isScheduledNow({ showFrom: '2026-12-26', showUntil: '2026-12-01' }, '2026-12-10'),
  )

  console.log('\n— What publishing would change —')

  const base = normaliseSections([
    { kind: 'hero', id: 'a', title: 'Welcome' },
    { kind: 'products', id: 'b', title: 'New in', source: 'newest' },
    { kind: 'cards', id: 'c', title: 'Info' },
  ])
  ok('an unchanged page reports nothing', describeLayoutChanges(base, base).length === 0)

  const added = describeLayoutChanges(base, normaliseSections([...base, { kind: 'text', id: 'd', title: 'Notice' }]))
  ok('a new section is reported', added.length === 1 && added[0].kind === 'added', JSON.stringify(added))

  const removed = describeLayoutChanges(base, base.slice(0, 2))
  ok('a removed section is reported', removed.length === 1 && removed[0].kind === 'removed')
  ok('and it is named', removed[0]?.label === 'Info', removed[0]?.label)

  /*
   * The property that makes the summary worth reading: dragging ONE section
   * must report one move, not "everything changed". Reporting every section
   * the drag pushed past is true and useless.
   */
  const moved = describeLayoutChanges(base, [base[2], base[0], base[1]])
  ok(
    'a reorder reports moves, not edits',
    moved.length > 0 && moved.every((c) => c.kind === 'moved'),
    JSON.stringify(moved.map((c) => c.kind)),
  )
  ok(
    'dragging one section reports exactly one move',
    moved.length === 1 && moved[0].label === 'Info',
    `${moved.length}: ${moved.map((c) => c.label).join(', ')}`,
  )

  // A section removed from the middle displaces the ones below it, but nobody
  // moved them — that must read as one removal, not a removal plus two moves.
  const removedMiddle = describeLayoutChanges(base, [base[0], base[2]])
  ok(
    'removing from the middle is not also a reorder',
    removedMiddle.length === 1 && removedMiddle[0].kind === 'removed',
    JSON.stringify(removedMiddle.map((c) => c.kind)),
  )

  const hidden = describeLayoutChanges(
    base,
    base.map((s) => (s.id === 'b' ? { ...s, enabled: false } : s)),
  )
  ok('switching a section off is its own kind', hidden.length === 1 && hidden[0].kind === 'hidden')

  /*
   * ── THE PRESET CASE ─────────────────────────────────────────────────
   *
   * Applying a ready-made page rebuilds every section with a fresh id. Diffed
   * naively that reads as "New: Welcome banner" directly above "Removed:
   * Welcome banner" for every row — accurate, and worthless to read. Found by
   * looking at the real dialog.
   */
  const reIded = base.map((s) => ({ ...s, id: `${s.id}-fresh` }))
  ok(
    'the same page with new ids reports no change at all',
    describeLayoutChanges(base, reIded).length === 0,
    JSON.stringify(describeLayoutChanges(base, reIded)),
  )

  const reIdedEdited = reIded.map((s) =>
    s.id === 'a-fresh' ? { ...s, tone: 'tinted' as const } : s,
  )
  const presetEdit = describeLayoutChanges(base, reIdedEdited)
  ok(
    'but a real difference under a new id still reports',
    presetEdit.length === 1 && presetEdit[0].kind === 'edited' && presetEdit[0].detail === 'background',
    JSON.stringify(presetEdit),
  )

  // A genuinely different section must not be swallowed by the pairing.
  const swapped = describeLayoutChanges(
    base,
    [...base.slice(0, 2), { ...base[2], id: 'z', title: 'Something else' }],
  )
  ok(
    'a differently named replacement is still an add and a remove',
    swapped.some((c) => c.kind === 'added') && swapped.some((c) => c.kind === 'removed'),
    JSON.stringify(swapped.map((c) => c.kind)),
  )

  const retitled = describeLayoutChanges(
    base,
    base.map((s) => (s.id === 'a' ? { ...s, title: 'Hello' } : s)),
  )
  ok('an edit is reported', retitled.length === 1 && retitled[0].kind === 'edited')
  ok('and says WHAT changed', retitled[0]?.detail === 'heading', retitled[0]?.detail)

  const rescheduled = describeLayoutChanges(
    base,
    base.map((s) => (s.id === 'c' ? { ...s, showUntil: '2026-12-26' } : s)),
  )
  ok(
    'a schedule change is reported in the owner’s words',
    rescheduled[0]?.detail === 'when it shows',
    rescheduled[0]?.detail,
  )

  console.log('\n— Nothing hostile reaches a public page —')

  /*
   * A banner link is the one place a shop owner supplies an href that lands on
   * a public page, so it gets its own guard rather than reusing safeUrl: the
   * common case is an in-shop path, which safeUrl rejects outright.
   */
  ok('a javascript: banner link is refused', safeLinkTarget('javascript:alert(1)') === '')
  ok('a data: banner link is refused', safeLinkTarget('data:text/html,<script>') === '')
  // The subtle one. A browser reads `//host` as protocol-relative and follows
  // it off-site, so a banner pointing there would quietly leave the shop.
  ok('a protocol-relative banner link is refused', safeLinkTarget('//evil.example/x') === '')
  ok('an in-shop path is allowed', safeLinkTarget('/store/abc?department=2') === '/store/abc?department=2')
  ok('an https banner link is allowed', safeLinkTarget('https://example.com/sale').startsWith('https://'))
  ok('a blank banner link stays blank', safeLinkTarget('  ') === '')
  ok(
    'a hostile link never survives normalisation',
    normaliseSections([{ kind: 'banner', id: 'b', linkUrl: 'javascript:alert(1)' }])[0].linkUrl === '',
  )

  ok('a CSS-injection colour is refused', safeColour('red; background:url(//evil)') === DEFAULT_BRAND_COLOUR)
  ok('a valid hex is kept', safeColour('#ff0000') === '#ff0000')
  ok('a short hex is kept', safeColour('#f00') === '#f00')
  ok('an empty colour falls back', safeColour('') === DEFAULT_BRAND_COLOUR)
  ok('a javascript: link is refused', safeUrl('javascript:alert(1)') === '')
  ok('a data: link is refused', safeUrl('data:text/html,<script>') === '')
  ok('an https link is kept', safeUrl('https://facebook.com/shop').startsWith('https://'))

  console.log('\n— A draft is not live —')
  // Start from a known published page.
  await siteExecute(SITE, `UPDATE online_store_settings SET home_layout = ?, home_layout_draft = NULL WHERE id = 1`, [
    JSON.stringify(defaultSections()),
  ])
  const livePage = (await getPublishedLayout(SITE)).sections
  ok('the shop has a published page', livePage.length > 0, `${livePage.length} sections`)

  await saveDraft(SITE, [
    { kind: 'hero', id: 'only', title: 'DRAFT ONLY', enabled: true },
  ])

  const afterDraft = await getLayout(SITE)
  ok('the draft is stored', afterDraft.draft?.length === 1)
  ok('the draft has the new content', afterDraft.draft?.[0].title === 'DRAFT ONLY')
  // The whole point of two columns.
  ok(
    'the PUBLISHED page has not moved',
    JSON.stringify(afterDraft.published) === JSON.stringify(livePage),
  )
  ok(
    'and the shop still serves the old page',
    (await getPublishedLayout(SITE)).sections[0].title !== 'DRAFT ONLY',
  )

  console.log('\n— Publishing —')
  const published = await publishDraft(SITE)
  ok('publishing succeeds', published.ok, published.ok ? '' : published.error)
  const afterPublish = await getLayout(SITE)
  ok('the draft is now live', afterPublish.published[0].title === 'DRAFT ONLY')
  ok('and the draft is cleared', afterPublish.draft === null)
  ok('publishing twice is refused', !(await publishDraft(SITE)).ok)

  console.log('\n— Discarding —')
  await saveDraft(SITE, [{ kind: 'hero', id: 'x', title: 'THROW AWAY', enabled: true }])
  ok('there is a draft to discard', (await getLayout(SITE)).draft !== null)
  await discardDraft(SITE)
  const afterDiscard = await getLayout(SITE)
  ok('the draft is gone', afterDiscard.draft === null)
  ok('the live page is untouched', afterDiscard.published[0].title === 'DRAFT ONLY')

  console.log('\n— Hidden sections and starter pages —')
  await siteExecute(SITE, `UPDATE online_store_settings SET home_layout = ?, home_layout_draft = NULL WHERE id = 1`, [
    JSON.stringify([
      { id: 'a', kind: 'hero', title: 'Shown', enabled: true },
      { id: 'b', kind: 'hero', title: 'Hidden', enabled: false },
    ]),
  ])
  const visible = await getPublishedLayout(SITE)
  ok('a disabled section is not served', visible.sections.length === 1 && visible.sections[0].title === 'Shown')

  await siteExecute(SITE, `UPDATE online_store_settings SET home_layout = NULL WHERE id = 1`)
  ok('never published → the starter page', (await getLayout(SITE)).published.length === defaultSections().length)

  await siteExecute(SITE, `UPDATE online_store_settings SET home_layout = '[]' WHERE id = 1`)
  // Distinct from NULL: the owner deliberately removed everything.
  ok('an empty page is respected, not replaced', (await getLayout(SITE)).published.length === 0)

  await siteExecute(SITE, `UPDATE online_store_settings SET home_layout = 'not json' WHERE id = 1`)
  ok('a corrupted layout falls back instead of throwing', (await getLayout(SITE)).published.length > 0)

  console.log('\n— Theme —')
  await saveTheme(SITE, {
    brandColour: 'javascript:alert(1)',
    productLayout: 'list',
    heroHeadline: 'Fresh every morning',
    socialFacebook: 'javascript:alert(1)',
    socialInstagram: 'https://instagram.com/shop',
    socialWhatsapp: '+27 82 123 4567',
  })
  const theme = (await getLayout(SITE)).theme
  ok('a hostile colour never persists', theme.brandColour === DEFAULT_BRAND_COLOUR, theme.brandColour)
  ok('a hostile link never persists', theme.socialFacebook === '')
  ok('a real link does', theme.socialInstagram === 'https://instagram.com/shop')
  ok('a phone number is reduced to digits', theme.socialWhatsapp === '+27821234567', theme.socialWhatsapp)
  ok('the layout choice is kept', theme.productLayout === 'list')
  ok('the headline is kept', theme.heroHeadline === 'Fresh every morning')

  console.log('\n— Cleanup —')
  await siteExecute(
    SITE,
    `UPDATE online_store_settings
        SET brand_colour = ?, product_layout = ?, hero_headline = ?, hero_subtext = ?,
            footer_about = ?, footer_hours = ?, social_facebook = ?, social_instagram = ?,
            social_whatsapp = ?, home_layout = ?, home_layout_draft = ?
      WHERE id = 1`,
    [
      before?.brand_colour ?? DEFAULT_BRAND_COLOUR,
      before?.product_layout ?? 'grid',
      before?.hero_headline ?? '',
      before?.hero_subtext ?? '',
      before?.footer_about ?? '',
      before?.footer_hours ?? '',
      before?.social_facebook ?? '',
      before?.social_instagram ?? '',
      before?.social_whatsapp ?? '',
      before?.home_layout ?? null,
      before?.home_layout_draft ?? null,
    ],
  )
  const restored = await getLayout(SITE)
  ok('settings restored', restored.theme.heroHeadline === String(before?.hero_headline ?? ''))
  ok('no draft left behind', restored.draft === (before?.home_layout_draft ? restored.draft : null))

  console.log(`\n${fails === 0 ? 'All builder checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

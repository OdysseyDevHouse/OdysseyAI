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
  getTheme,
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
import {
  MAX_VERSIONS,
  createPage,
  deletePage,
  deleteSavedSection,
  departmentPage,
  discardPageDraft,
  getPage,
  listSavedSections,
  listVersions,
  productPage,
  publishDuePages,
  restoreVersion,
  saveSection,
  schedulePublish,
  getPageLayout,
  getPageSectionsFor,
  getPublishedPageLayout,
  homePage,
  listPages,
  navPages,
  publishPageDraft,
  publishedPageBySlug,
  savePageDraft,
  savePageSettings,
} from '../src/lib/site/storefrontPages'
import { createPreviewToken, verifyPreviewToken } from '../src/lib/previewToken'
import { createPublicStoreToken } from '../src/lib/publicStoreToken'
import {
  MAX_QUOTES,
  MAX_RICH_BLOCKS,
  BRAND_SWATCHES,
  SECTION_KINDS,
  announcementShowing,
  brandColourProblem,
  contrastRatio,
  groupRichBlocks,
  kindsFor,
  pageWarnings,
  safeDateTime,
  safeFontKey,
  safeSlug,
  slugProblem,
  sourcesFor,
} from '../src/lib/storefrontModel'

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
    // Every column saveTheme writes. Anything missing here is a value this
    // test leaves rewritten on a real shop — which is exactly what happened
    // when the font and announcement columns arrived and this list did not
    // grow with them.
    `SELECT brand_colour, product_layout, hero_headline, hero_subtext, footer_about,
            footer_hours, social_facebook, social_instagram, social_whatsapp,
            font_key, share_image_id, announce_text, announce_link,
            announce_from, announce_until
       FROM online_store_settings WHERE id = 1`,
  )
  // The front page lives in its own row since 070. Snapshotted separately
  // because it is a different table, and restored the same way — a test that
  // leaves a shop's real front page rewritten is worse than one that fails.
  const beforePage = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT layout, layout_draft FROM storefront_pages WHERE kind = 'home'`,
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
  // Start from a known published page. On the PAGE row since 070 — the old
  // settings columns are still there and no longer read.
  await siteExecute(
    SITE,
    `UPDATE storefront_pages SET layout = ?, layout_draft = NULL WHERE kind = 'home'`,
    [JSON.stringify(defaultSections())],
  )
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
  /*
   * Written straight to the PAGE row, not to online_store_settings.
   *
   * 070 moved the layout off the settings row into `storefront_pages`, and the
   * old columns are deliberately still there but no longer read. Writing to
   * them here passed for exactly as long as it took to notice the assertions
   * were checking a column nothing loads.
   */
  const homeId = (await homePage(SITE))!.id
  await siteExecute(SITE, `UPDATE storefront_pages SET layout = ?, layout_draft = NULL WHERE id = ?`, [
    JSON.stringify([
      { id: 'a', kind: 'hero', title: 'Shown', enabled: true },
      { id: 'b', kind: 'hero', title: 'Hidden', enabled: false },
    ]),
    homeId,
  ])
  const visible = await getPublishedLayout(SITE)
  ok('a disabled section is not served', visible.sections.length === 1 && visible.sections[0].title === 'Shown')

  await siteExecute(SITE, `UPDATE storefront_pages SET layout = NULL WHERE id = ?`, [homeId])
  ok('never published → the starter page', (await getLayout(SITE)).published.length === defaultSections().length)

  await siteExecute(SITE, `UPDATE storefront_pages SET layout = '[]' WHERE id = ?`, [homeId])
  // Distinct from NULL: the owner deliberately removed everything.
  ok('an empty page is respected, not replaced', (await getLayout(SITE)).published.length === 0)

  await siteExecute(SITE, `UPDATE storefront_pages SET layout = 'not json' WHERE id = ?`, [homeId])
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

  console.log('\n— The new section kinds —')

  /*
   * Rich text stores a TREE, and the point of that is that no input can
   * produce a tag. These assert the two ways someone would try.
   */
  const richHostile = normaliseSections([
    {
      kind: 'richtext',
      id: 'r',
      blocks: [
        { type: 'script', spans: [{ text: 'x' }] },
        { type: 'p', spans: [{ text: 'ok', href: 'javascript:alert(1)' }] },
      ],
    },
  ])[0].blocks!
  ok('an unknown block type becomes a paragraph', richHostile[0].type === 'p', richHostile[0].type)
  ok('a javascript: link in a span never persists', richHostile[1].spans[0].href === '')
  ok('a real link in a span does', normaliseSections([
    { kind: 'richtext', id: 'r', blocks: [{ type: 'p', spans: [{ text: 'x', href: '/store' }] }] },
  ])[0].blocks![0].spans[0].href === '/store')

  const richCapped = normaliseSections([
    {
      kind: 'richtext',
      id: 'r',
      blocks: Array.from({ length: 500 }, () => ({ type: 'p', spans: [{ text: 'x' }] })),
    },
  ])[0].blocks!
  ok('the rich-block cap holds', richCapped.length === MAX_RICH_BLOCKS, `${richCapped.length}`)

  // Grouping: consecutive list items fold into one list, everything else does
  // not. The shop and the builder both render through this.
  const grouped = groupRichBlocks([
    { type: 'p', spans: [{ text: 'a' }] },
    { type: 'ul', spans: [{ text: 'one' }] },
    { type: 'ul', spans: [{ text: 'two' }] },
    { type: 'p', spans: [{ text: 'b' }] },
    { type: 'ul', spans: [{ text: 'three' }] },
  ])
  ok('consecutive list items fold into one list', grouped.length === 4, `${grouped.length} groups`)
  ok('and the folded list keeps both items', grouped[1].items.length === 2)
  ok('a list after a paragraph starts a new list', grouped[3].items.length === 1)

  /*
   * A video id lands inside a URL the renderer builds, so the character filter
   * IS the validation — it must make a second host unrepresentable.
   */
  const hostileVideo = normaliseSections([
    { kind: 'video', id: 'v', videoId: '../../evil.example/x?a=b', videoProvider: 'nope' },
  ])[0]
  ok('a video id cannot carry a path or a host', hostileVideo.videoId === 'evilexamplexab', hostileVideo.videoId)
  ok('an unknown provider falls back to youtube', hostileVideo.videoProvider === 'youtube')

  // A map link goes off-site by definition, so it is safeUrl and NOT
  // safeLinkTarget — a relative path here would point at a page of the shop.
  ok(
    'a javascript: map link never persists',
    normaliseSections([{ kind: 'map', id: 'm', mapUrl: 'javascript:alert(1)' }])[0].mapUrl === '',
  )

  // Logos take the same treatment as picked products: junk DISCARDED, never
  // clamped into a reference to picture 1 that nobody chose.
  const logoIds = normaliseSections([
    { kind: 'logos', id: 'l', logoImageIds: [3, -1, 'abc', 2.5, 7, 7] },
  ])[0].logoImageIds!
  ok('junk logo ids are discarded, not clamped', JSON.stringify(logoIds) === '[3,7]', JSON.stringify(logoIds))

  // A countdown to a moment that does not exist must fail to "no deadline",
  // which reads as empty — never to a wrong clock on a public page.
  ok('an impossible deadline becomes no deadline', safeDateTime('2026-02-31T10:00') === '')
  ok('a real deadline survives', safeDateTime('2026-12-25T17:30') === '2026-12-25T17:30')
  ok('a date with no time is not a deadline', safeDateTime('2026-12-25') === '')

  const quoteCapped = normaliseSections([
    { kind: 'testimonial', id: 't', quotes: Array.from({ length: 99 }, () => ({ quote: 'x' })) },
  ])[0].quotes!
  ok('the quote cap holds', quoteCapped.length === MAX_QUOTES)
  ok('quotes get distinct ids', new Set(quoteCapped.map((q) => q.id)).size === quoteCapped.length)

  /*
   * `sectionIsEmpty` is the rule the shop, the builder placeholder, the
   * publish summary AND the catalogue fallback all read. A new kind missing
   * from it renders an empty heading on a live shop.
   */
  // `blankTheme` is declared with the carousel checks above and reused here —
  // an empty theme is an empty theme.
  ok(
    'a reviews section with no reviews is empty',
    sectionIsEmpty({ section: normaliseSections([{ kind: 'reviews', id: 'x' }])[0], reviews: [] }, blankTheme),
  )
  ok(
    'a reviews section with one is not',
    !sectionIsEmpty({ section: normaliseSections([{ kind: 'reviews', id: 'x' }])[0], reviews: [{}] }, blankTheme),
  )
  ok(
    'a split with a picture but no words is empty',
    sectionIsEmpty(
      { section: normaliseSections([{ kind: 'split', id: 'x', imageId: 1 }])[0], image: {} },
      blankTheme,
    ),
  )
  ok(
    'a split with both is not',
    !sectionIsEmpty(
      {
        section: normaliseSections([{ kind: 'split', id: 'x', imageId: 1, bodyText: 'hi' }])[0],
        image: {},
      },
      blankTheme,
    ),
  )
  ok(
    'a finished countdown with nothing to say is empty',
    sectionIsEmpty(
      { section: normaliseSections([{ kind: 'countdown', id: 'x', endsAt: '2020-01-01T00:00' }])[0] },
      blankTheme,
    ),
  )
  ok(
    'a finished countdown WITH something to say is not',
    !sectionIsEmpty(
      {
        section: normaliseSections([
          { kind: 'countdown', id: 'x', endsAt: '2020-01-01T00:00', finishedText: 'Sale over' },
        ])[0],
      },
      blankTheme,
    ),
  )
  // Both draw themselves and are never empty — returning true would make them
  // impossible to add to a page.
  ok(
    'a divider is never empty',
    !sectionIsEmpty({ section: normaliseSections([{ kind: 'divider', id: 'x' }])[0] }, blankTheme),
  )
  ok(
    'a spacer is never empty',
    !sectionIsEmpty({ section: normaliseSections([{ kind: 'spacer', id: 'x' }])[0] }, blankTheme),
  )

  /*
   * Every kind must survive a round trip through normalisation, or the
   * builder's dirty check compares two different shapes and shows a permanent
   * "unsaved changes" that no amount of saving clears.
   */
  const allKinds = SECTION_KINDS.map((kind, i) => ({ kind, id: `k${i}` }))
  const once = normaliseSections(allKinds)
  const twice = normaliseSections(once)
  ok('every kind survives normalisation', once.length === SECTION_KINDS.length, `${once.length}/${SECTION_KINDS.length}`)
  ok('normalising twice changes nothing', JSON.stringify(once) === JSON.stringify(twice))

  console.log('\n— Earlier versions —')
  {
    const home = (await homePage(SITE))!

    // A known live page, then two publishes over it. Each should archive what
    // WAS live — not what replaced it.
    await siteExecute(
      SITE,
      `UPDATE storefront_pages SET layout = ?, layout_draft = NULL WHERE id = ?`,
      [JSON.stringify([{ id: 'v1', kind: 'text', title: 'VERSION ONE', enabled: true }]), home.id],
    )
    const startingVersions = (await listVersions(SITE, home.id)).length

    await savePageDraft(SITE, home.id, [
      { kind: 'text', id: 'v2', title: 'VERSION TWO', enabled: true },
    ])
    await publishPageDraft(SITE, home.id, 'Tester')

    const after = await listVersions(SITE, home.id)
    ok('publishing keeps what was live', after.length === startingVersions + 1)
    ok('and records who replaced it', after[0]?.replacedBy === 'Tester', after[0]?.replacedBy)
    ok('the live page is the new one', (await getPageLayout(SITE, home.id)).published[0].title === 'VERSION TWO')

    // Restoring loads the OLD one back as a draft, and must not touch live.
    const restored = await restoreVersion(SITE, home.id, after[0].id)
    ok('restoring succeeds', restored.ok)
    const afterRestore = await getPageLayout(SITE, home.id)
    ok('the old version is now the draft', afterRestore.draft?.[0].title === 'VERSION ONE')
    ok(
      'and restoring did NOT change what is live',
      afterRestore.published[0].title === 'VERSION TWO',
    )

    // A version belongs to one page — restoring another page's onto this one
    // would be a silent mix-up.
    ok(
      'a version id from nowhere is refused',
      !(await restoreVersion(SITE, home.id, 999999)).ok,
    )

    // The cap is applied on WRITE, so a shop republishing forever cannot grow
    // the table without bound.
    for (let i = 0; i < MAX_VERSIONS + 4; i++) {
      await savePageDraft(SITE, home.id, [
        { kind: 'text', id: `x${i}`, title: `PUB ${i}`, enabled: true },
      ])
      await publishPageDraft(SITE, home.id, 'Tester')
    }
    const capped = await listVersions(SITE, home.id)
    ok('the version cap holds', capped.length === MAX_VERSIONS, `${capped.length}`)
    ok('and the newest is kept', capped[0].sectionCount === 1)

    await discardPageDraft(SITE, home.id)
  }

  console.log('\n— Publishing later —')
  {
    const home = (await homePage(SITE))!
    await savePageDraft(SITE, home.id, [
      { kind: 'text', id: 'sched', title: 'SCHEDULED', text: 'x', enabled: true },
    ])

    ok('a time in the past is refused', !(await schedulePublish(SITE, home.id, '2020-01-01T00:00')).ok)
    ok('a junk time clears rather than storing', (await schedulePublish(SITE, home.id, 'nonsense')).ok)
    ok('and nothing is scheduled', (await getPage(SITE, home.id))?.publishAt === '')

    ok('a future time is accepted', (await schedulePublish(SITE, home.id, '2030-06-01T06:00')).ok)
    ok('and is stored', (await getPage(SITE, home.id))?.publishAt === '2030-06-01T06:00')

    // Early must publish NOTHING — the asymmetry the tick is built around.
    const early = await publishDuePages(SITE)
    ok('nothing publishes before its time', early.published === 0)
    ok('and it stays scheduled', (await getPage(SITE, home.id))?.publishAt === '2030-06-01T06:00')

    // Due now: a moment already past fires on the next sweep.
    await siteExecute(
      SITE,
      `UPDATE storefront_pages SET publish_at = '2020-01-01T00:00' WHERE id = ?`,
      [home.id],
    )
    const fired = await publishDuePages(SITE)
    ok('a due page publishes', fired.published === 1, JSON.stringify(fired))
    ok(
      'the draft is now live',
      (await getPageLayout(SITE, home.id)).published[0].title === 'SCHEDULED',
    )
    ok('the schedule is cleared', (await getPage(SITE, home.id))?.publishAt === '')
    // Cleared even on failure, so a page that cannot publish is not retried
    // forever on every tick.
    ok('and it does not fire again', (await publishDuePages(SITE)).published === 0)

    await discardPageDraft(SITE, home.id)
  }

  console.log('\n— Saved sections —')
  {
    const made = await saveSection(SITE, 'ZZ Test cards', {
      kind: 'cards',
      id: 'c',
      title: 'Why us',
      cards: [{ icon: '🚚', heading: 'Delivery', text: 'Tuesdays.' }],
    })
    ok('a section can be saved', made.ok, made.ok ? '' : made.error)

    const dupe = await saveSection(SITE, 'ZZ Test cards', { kind: 'text', id: 't' })
    ok('a duplicate name is refused', !dupe.ok)
    ok('an unnamed one is refused', !(await saveSection(SITE, '   ', { kind: 'text', id: 't' })).ok)
    // Normalised on the way in, so nothing can be stored in a shape the
    // builder could not have produced.
    ok('an unknown kind cannot be saved', !(await saveSection(SITE, 'ZZ Test junk', { kind: 'evil' })).ok)

    const saved = (await listSavedSections(SITE)).find((s) => s.name === 'ZZ Test cards')
    ok('it comes back', saved !== undefined)
    ok('with its kind', saved?.kind === 'cards', saved?.kind)
    ok('and its content', saved?.section.cards?.[0].heading === 'Delivery')

    ok('it can be forgotten', (await deleteSavedSection(SITE, saved!.id)).ok)
    ok(
      'and is then gone',
      !(await listSavedSections(SITE)).some((s) => s.name === 'ZZ Test cards'),
    )
  }

  console.log('\n— Previewing a draft —')
  {
    /*
     * A preview pass shows work the owner has deliberately NOT published, so
     * the three ways it could leak are each asserted: a pass for another site,
     * a pass for another page, and a token minted for something else entirely.
     */
    const home = (await homePage(SITE))!
    const pass = await createPreviewToken(SITE, home.id)
    const claim = await verifyPreviewToken(pass)
    ok('a pass round-trips', claim?.siteId === SITE && claim?.pageId === home.id)
    ok('a junk pass is refused', (await verifyPreviewToken('not-a-token')) === null)
    // Different audience — the signature verifies and the audience check still
    // rejects it, which is the point of giving each token its own.
    ok(
      'a storefront token cannot be replayed as a preview pass',
      (await verifyPreviewToken(await createPublicStoreToken(SITE))) === null,
    )

    await savePageDraft(SITE, home.id, [
      { kind: 'text', id: 'draftonly', title: 'DRAFT ONLY', text: 'x', enabled: true },
    ])

    const anonymous = await getPageSectionsFor(SITE, home.id, null)
    ok('without a pass the published page is served', !anonymous.isPreview)
    ok(
      'and the draft is not visible',
      !anonymous.sections.some((s) => s.title === 'DRAFT ONLY'),
    )

    const previewing = await getPageSectionsFor(SITE, home.id, claim)
    ok('with a pass the draft is served', previewing.isPreview)
    ok('and the draft content is there', previewing.sections.some((s) => s.title === 'DRAFT ONLY'))

    ok(
      'a pass for another page does not unlock this one',
      !(await getPageSectionsFor(SITE, home.id, { siteId: SITE, pageId: home.id + 9999 }))
        .isPreview,
    )
    // The load-bearing one: it is what stops one shop previewing another's.
    ok(
      'a pass for another site is ignored',
      !(await getPageSectionsFor(SITE, home.id, { siteId: 9999, pageId: home.id })).isPreview,
    )

    await discardPageDraft(SITE, home.id)
  }

  console.log('\n— Presentation —')
  {
    // A font is a KEY into a curated list, never a name — see FONT_KEYS. A
    // stored name would end up in a stylesheet and could become a request to
    // somewhere unexpected.
    ok('a known font key survives', safeFontKey('lora') === 'lora')
    ok('an unknown font falls back to the device', safeFontKey('Comic Sans') === 'system')
    ok('a missing font falls back too', safeFontKey(undefined) === 'system')

    // The strip's link lands in an href on a page that takes payments.
    await saveTheme(SITE, {
      brandColour: '#2f6fed',
      productLayout: 'grid',
      fontKey: 'lora',
      announceText: 'Free delivery over R500',
      announceLink: 'javascript:alert(1)',
      announceFrom: '2026-01-01',
      announceUntil: 'not-a-date',
    })
    const t = await getTheme(SITE)
    ok('the font choice is kept', t.fontKey === 'lora')
    ok('the strip text is kept', t.announceText === 'Free delivery over R500')
    ok('a hostile strip link never persists', t.announceLink === '')
    ok('a real strip date is kept', t.announceFrom === '2026-01-01')
    ok('a junk strip date becomes no bound', t.announceUntil === '')

    // Showing is text AND schedule — either can switch it off.
    ok('a dated strip in season shows', announcementShowing(t, '2026-06-01'))
    ok('and out of season does not', !announcementShowing(t, '2025-06-01'))
    ok(
      'no text means no strip whatever the dates',
      !announcementShowing({ ...t, announceText: '   ' }, '2026-06-01'),
    )
  }

  console.log('\n— Is the shop’s colour readable —')
  {
    // The two anchors of the WCAG scale. If these are wrong the rest is
    // meaningless, and both are exact rather than approximate.
    ok('black on white is 21:1', Math.round(contrastRatio('#000000', '#ffffff')) === 21)
    ok('a colour against itself is 1:1', Math.round(contrastRatio('#2f6fed', '#2f6fed')) === 1)
    ok('the order of the pair does not matter',
      contrastRatio('#000000', '#ffffff') === contrastRatio('#ffffff', '#000000'))

    /*
     * The gamma expansion, asserted directly.
     *
     * A naive channel average calls yellow dark and blue light, which is
     * backwards — and would PASS exactly the pale colours this check exists
     * to catch. Pure yellow against white is genuinely awful (about 1.07:1);
     * pure blue against white is genuinely fine (about 8.6:1).
     */
    ok('yellow is understood as light', contrastRatio('#ffff00', '#ffffff') < 1.5)
    ok('blue is understood as dark', contrastRatio('#0000ff', '#ffffff') > 8)

    // Every ready-made swatch must pass — they are offered as the safe option,
    // and the warning tells owners so.
    const badSwatches = BRAND_SWATCHES.filter((c) => brandColourProblem(c) !== '')
    ok('every ready-made swatch is readable', badSwatches.length === 0, badSwatches.join(','))

    // A pale colour is the case this exists for: white button labels on it are
    // invisible, and the owner cannot fix that by other means.
    ok('a pale colour is flagged', brandColourProblem('#ffe066') !== '')
    ok('a very pale one too', brandColourProblem('#f5f5f5') !== '')
    ok('a mid-weight one is not', brandColourProblem('#2f6fed') === '')
    ok('and a very dark one is not', brandColourProblem('#1a1a1a') === '')

    // Junk goes through safeColour first, so it is judged as the DEFAULT
    // rather than throwing on a colour that cannot exist in the database.
    ok('junk is judged as the default', brandColourProblem('not-a-colour') === '')
    // The short hex form is a real hex and must be expanded, not misread —
    // #fff read as three channels of 15 would look almost black.
    ok('the short hex form is expanded', brandColourProblem('#fff') !== '')
  }

  console.log('\n— Warnings before publishing —')
  {
    const clean = pageWarnings(
      normaliseSections([{ kind: 'banner', id: 'b', imageId: 3, imageAlt: 'Bread' }]),
    )
    ok('a described picture is not a warning', clean.length === 0)

    const undescribed = pageWarnings(
      normaliseSections([{ kind: 'banner', id: 'b', imageId: 3, imageAlt: '  ' }]),
    )
    ok('an undescribed picture is', undescribed[0]?.count === 1, JSON.stringify(undescribed))

    // Rolled up, so ten banners are one line rather than ten.
    const many = pageWarnings(
      normaliseSections([
        { kind: 'banner', id: 'a', imageId: 1 },
        { kind: 'split', id: 'b', imageId: 2, bodyText: 'x' },
        { kind: 'carousel', id: 'c', slides: [{ id: 's', imageId: 3 }] },
      ]),
    )
    ok('every kind of picture is counted', many[0]?.count === 3, JSON.stringify(many))

    // A hidden section is not a problem yet — warning about one nobody will
    // see is the noise that stops the check being read at all.
    const hidden = pageWarnings(
      normaliseSections([{ kind: 'banner', id: 'b', imageId: 3, enabled: false }]),
    )
    ok('a hidden section is not warned about', hidden.length === 0)

    const deadButton = pageWarnings(
      normaliseSections([{ kind: 'banner', id: 'b', imageId: 1, imageAlt: 'x', buttonLabel: 'Shop' }]),
    )
    ok('a button with nowhere to go is flagged', deadButton.some((w) => w.label.includes('button')))
  }

  console.log('\n— Product pages —')
  {
    // The two rules that only mean anything with a product to be relative to.
    ok('a front page is not offered the cross-sell rules', !sourcesFor('home').includes('together'))
    ok('nor the same-department one', !sourcesFor('standard').includes('sameDepartment'))
    ok('a product page is offered both', sourcesFor('product').includes('together') && sourcesFor('product').includes('sameDepartment'))
    ok('and still has the ordinary ones', sourcesFor('product').includes('manual'))

    // A product page's sections sit BELOW one product, so the blocks that
    // would turn it into a second front page are not offered.
    const productKinds = kindsFor('product')
    ok('a product page cannot hold a carousel', !productKinds.includes('carousel'))
    ok('nor a department grid', !productKinds.includes('categories'))
    ok('nor the welcome banner', !productKinds.includes('hero'))
    ok('but it can hold a product row', productKinds.includes('products'))
    ok('and recently viewed', productKinds.includes('recent'))

    // 'recent' lives in the browser, so the server cannot answer for it — it
    // must never be judged empty or the shop would drop a section that has
    // content. The component decides for itself.
    ok(
      'a recently-viewed section is never judged empty',
      !sectionIsEmpty({ section: normaliseSections([{ kind: 'recent', id: 'r' }])[0] }, blankTheme),
    )

    // One arrangement per shop — the same mechanism that guarantees one home
    // page, since department_id is NULL for this kind.
    const first = await createPage(SITE, { kind: 'product', title: 'ZZ Test product page' })
    ok('a product page can be created', first.ok, first.ok ? '' : first.error)
    const second = await createPage(SITE, { kind: 'product', title: 'Another' })
    ok('a second one is refused', !second.ok)
    ok('and it is found by kind', (await productPage(SITE)) !== null)

    if (first.ok) {
      // It has no slug and no department — it is not addressable, it decorates.
      const row = await getPage(SITE, first.id)
      ok('a product page has no slug', row?.slug === '')
      ok('and no department', row?.departmentId === null)
      ok('it can be deleted', (await deletePage(SITE, first.id)).ok)
      ok('and then another can be made', (await createPage(SITE, { kind: 'product', title: 'ZZ Test again' })).ok)
    }
  }

  console.log('\n— Slugs —')
  ok('a title becomes a slug', safeSlug('Delivery & Returns!') === 'delivery-returns', safeSlug('Delivery & Returns!'))
  ok('runs of junk collapse to one hyphen', safeSlug('a  ///  b') === 'a-b', safeSlug('a  ///  b'))
  ok('leading and trailing hyphens go', safeSlug('--about--') === 'about')
  ok('an empty slug is refused', slugProblem('') !== '')
  ok('a reserved slug is refused', slugProblem('checkout') !== '')
  ok('a taken slug is refused', slugProblem('about', ['about']) !== '')
  ok('a good slug passes', slugProblem('about', ['delivery']) === '')

  console.log('\n— Pages —')
  const home = await homePage(SITE)
  ok('every shop has exactly one front page', home !== null && home.kind === 'home')
  ok('the front page cannot be deleted', !(await deletePage(SITE, home!.id)).ok)

  const made = await createPage(SITE, { kind: 'standard', title: 'ZZ Test Delivery', slug: 'zz-test-delivery' })
  ok('a standard page is created', made.ok, made.ok ? '' : made.error)
  const pageId = made.ok ? made.id : 0

  const dupe = await createPage(SITE, { kind: 'standard', title: 'Another', slug: 'zz-test-delivery' })
  ok('a duplicate slug is refused', !dupe.ok)
  const reserved = await createPage(SITE, { kind: 'standard', title: 'Nope', slug: 'checkout' })
  ok('a reserved slug is refused at creation', !reserved.ok)

  /*
   * The property the whole table exists for: a new page is NOT live.
   *
   * Creating a page and having it instantly appear, empty, on the public shop
   * is the opposite of what the draft mechanism is for.
   */
  ok('a new page starts unpublished', (await publishedPageBySlug(SITE, 'zz-test-delivery')) === null)
  ok('an unpublished page has no starter sections', (await getPageLayout(SITE, pageId)).published.length === 0)

  await savePageDraft(SITE, pageId, [{ kind: 'text', id: 't', title: 'Delivery', text: 'Tuesdays.', enabled: true }])
  ok('the draft is saved', (await getPageLayout(SITE, pageId)).draft?.length === 1)
  ok('and the page is still not live', (await getPageLayout(SITE, pageId)).published.length === 0)

  await publishPageDraft(SITE, pageId)
  const publishedPage = await getPageLayout(SITE, pageId)
  ok(
    'publishing moves the draft across',
    publishedPage.published.length === 1 && publishedPage.draft === null,
  )

  // Still 404s: a published LAYOUT and a published PAGE are different questions.
  ok('a page with a layout is still hidden until published', (await publishedPageBySlug(SITE, 'zz-test-delivery')) === null)
  await savePageSettings(SITE, pageId, { isPublished: true, showInNav: true })
  ok('once published it resolves by slug', (await publishedPageBySlug(SITE, 'zz-test-delivery')) !== null)
  ok('and it appears in the nav', (await navPages(SITE)).some((p) => p.id === pageId))

  /*
   * Draft isolation between pages — the reason draft-and-publish moved off the
   * settings row at all. An owner rewriting one page must not be blocked from
   * publishing another.
   */
  await savePageDraft(SITE, pageId, [{ kind: 'text', id: 't', title: 'Edited', text: 'x', enabled: true }])
  ok('one page having a draft leaves the front page alone', (await getLayout(SITE)).draft === null)

  const homeSections = (await getPageLayout(SITE, home!.id)).published
  ok('and the front page still has its own sections', Array.isArray(homeSections))

  ok('the front page is excluded from the nav', !(await navPages(SITE)).some((p) => p.kind === 'home'))
  ok('the pages list puts home first', (await listPages(SITE))[0].kind === 'home')

  // A department with no page returns nothing rather than an empty page — the
  // difference between "renders as it always did" and "renders blank".
  ok('a department with no page has none', (await departmentPage(SITE, 999999)) === null)

  ok('a page can be deleted', (await deletePage(SITE, pageId)).ok)
  ok('and is then unreachable', (await publishedPageBySlug(SITE, 'zz-test-delivery')) === null)

  console.log('\n— Cleanup —')
  await siteExecute(
    SITE,
    `UPDATE online_store_settings
        SET brand_colour = ?, product_layout = ?, hero_headline = ?, hero_subtext = ?,
            footer_about = ?, footer_hours = ?, social_facebook = ?, social_instagram = ?,
            social_whatsapp = ?, font_key = ?, share_image_id = ?,
            announce_text = ?, announce_link = ?, announce_from = ?, announce_until = ?
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
      before?.font_key ?? 'system',
      before?.share_image_id ?? null,
      before?.announce_text ?? '',
      before?.announce_link ?? '',
      before?.announce_from ?? '',
      before?.announce_until ?? '',
    ],
  )
  await siteExecute(
    SITE,
    `UPDATE storefront_pages SET layout = ?, layout_draft = ? WHERE kind = 'home'`,
    [beforePage?.layout ?? null, beforePage?.layout_draft ?? null],
  )
  // Any page this test created along the way. Scoped to the test's own slug
  // prefix so a real page an owner made is never swept up.
  await siteExecute(SITE, `DELETE FROM storefront_pages WHERE slug LIKE 'zz-test-%'`)
  // Product pages have no slug — see 079 — so the filter above cannot reach
  // them, and one left behind makes the next run's "can be created" fail
  // against its own leftovers. Scoped to this test's own titles.
  await siteExecute(SITE, `DELETE FROM storefront_pages WHERE kind = 'product' AND title LIKE 'ZZ Test%'`)
  // The version rows the publish tests wrote. Scoped to this test's own
  // marker so a shop's real history is never swept up — and worth doing,
  // because otherwise a run leaves the front page's history full of "PUB 7".
  await siteExecute(SITE, `DELETE FROM storefront_page_versions WHERE replaced_by = 'Tester'`)
  await siteExecute(SITE, `DELETE FROM storefront_saved_sections WHERE name LIKE 'ZZ Test%'`)

  const restored = await getLayout(SITE)
  ok('settings restored', restored.theme.heroHeadline === String(before?.hero_headline ?? ''))
  ok('no draft left behind', restored.draft === (beforePage?.layout_draft ? restored.draft : null))

  console.log(`\n${fails === 0 ? 'All builder checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

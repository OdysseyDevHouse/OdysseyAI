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
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  MAX_SECTION_ITEMS,
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

  console.log('\n— Nothing hostile reaches a public page —')
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

/**
 * How a listing is configured, and the cascade that resolves it.
 *
 * ── WHAT THIS IS GUARDING ────────────────────────────────────────────────
 *
 * The cascade is two steps — the department's own row, else the shop's default
 * — and both directions matter. A department that never asked for anything must
 * follow the shop INCLUDING as the shop changes its mind later, and one that
 * overrode something must keep it. A "follow the default" that quietly froze at
 * whatever the default was on the day would be worse than no cascade at all,
 * because nobody would notice for months.
 *
 *   npm run test:listing-presets
 */
import {
  clearListingPreset,
  listListingPresets,
  listingPresetFor,
  saveListingPreset,
  shopListingPreset,
} from '../src/lib/site/listingPresets'
import {
  CARD_FIELDS,
  DEFAULT_LISTING,
  LISTING_FACETS,
  PER_PAGE_CHOICES,
  badgesFor,
  DEFAULT_BADGE_RULES,
  gridClass,
  readListingPreset,
  safeBadgeTone,
  MAX_TILE_BADGES,
} from '../src/lib/storefront/listing'
import { siteQuery } from '../src/lib/siteDb'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  /*
   * A real department, and its settings put back at the end whatever happens.
   * This suite writes to a live site's configuration, so leaving a two-column
   * override behind would silently restyle a shop for the next person to look
   * at it.
   */
  const [dept] = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM departments ORDER BY id LIMIT 1`,
  )
  if (!dept) throw new Error('Need a department to test against.')

  const shopBefore = await shopListingPreset(SITE)
  const deptBefore = await listingPresetFor(SITE, dept.id)
  const hadOwnRow = (await listListingPresets(SITE)).has(dept.id)

  console.log('\n— Reading a row that is not there —')
  {
    ok(
      'a shop with nothing configured gets the built-in default',
      JSON.stringify(readListingPreset(null)) === JSON.stringify(DEFAULT_LISTING),
    )
    ok('and the default shows every part of a tile', DEFAULT_LISTING.cardFields.length === CARD_FIELDS.length)
  }

  console.log('\n— Nothing unusable survives being stored —')
  {
    const junk = readListingPreset({
      department_id: 'abc',
      columns_desktop: 99,
      columns_phone: 0,
      per_page: 7,
      default_sort: '; DROP TABLE products',
      layout: 'carousel',
      card_fields: 'brand,nonsense,price',
      facets: 'brand,notafacet',
    })
    ok('an absurd column count clamps', junk.columnsDesktop === 6, String(junk.columnsDesktop))
    ok('a phone cannot show zero columns', junk.columnsPhone === 1, String(junk.columnsPhone))
    // A page size off the list is a ragged last row at every column count, so
    // it falls back rather than clamping to the nearest.
    ok('an off-list page size falls back', junk.perPage === DEFAULT_LISTING.perPage, String(junk.perPage))
    ok('a junk sort falls back', junk.defaultSort === 'name', junk.defaultSort)
    ok('a junk layout falls back', junk.layout === 'grid', junk.layout)
    ok('an unknown card field is dropped', junk.cardFields.join(',') === 'brand,price', junk.cardFields.join(','))
    ok('an unknown facet is dropped', junk.facets.join(',') === 'brand', junk.facets.join(','))
    ok('a junk department id reads as the shop default', junk.departmentId === null)

    /*
     * Order comes from the VOCABULARY, not from the stored string. Otherwise a
     * tile would draw its price above its name because of the sequence somebody's
     * checkboxes happened to be saved in.
     */
    const reversed = readListingPreset({ card_fields: 'price,brand,department' })
    ok(
      'card fields keep the declared order, not the stored one',
      reversed.cardFields.join(',') === 'department,brand,price',
      reversed.cardFields.join(','),
    )

    // An owner who switched everything off meant it — that must survive, or the
    // one thing they explicitly asked for is the one thing they cannot have.
    const empty = readListingPreset({ card_fields: '', facets: '' })
    ok('switching every facet off is a real answer', empty.facets.length === 0)
    ok('switching every tile field off is a real answer', empty.cardFields.length === 0)
  }

  console.log('\n— The grid classes are literal —')
  {
    const all: string[] = []
    for (const phone of [1, 2]) {
      for (const desktop of [2, 3, 4, 5, 6]) all.push(gridClass(phone, desktop))
    }
    /*
     * Tailwind extracts class names statically, so an interpolated
     * `grid-cols-${n}` is a class the stylesheet does not contain — the grid
     * collapses to one column and nothing errors, which is the failure that
     * only shows on a shop.
     */
    ok('every combination yields a real class', all.every((c) => c.includes('grid-cols-')))
    ok('none of them is built at runtime', all.every((c) => !c.includes('$')))
    ok('an unknown column count still yields a grid', gridClass(2, 99).includes('grid-cols-'))
  }

  console.log('\n— The cascade —')
  {
    await clearListingPreset(SITE, dept.id)
    const followed = await listingPresetFor(SITE, dept.id)
    const shop = await shopListingPreset(SITE)
    ok(
      'a department with no row of its own follows the shop',
      followed.columnsDesktop === shop.columnsDesktop && followed.perPage === shop.perPage,
    )

    // The point of "follow": the shop's LATER changes have to reach it.
    await saveListingPreset(SITE, { ...DEFAULT_LISTING, departmentId: null, columnsDesktop: 3 }, 'test')
    const afterShopChange = await listingPresetFor(SITE, dept.id)
    ok(
      'and keeps following when the shop changes its mind',
      afterShopChange.columnsDesktop === 3,
      String(afterShopChange.columnsDesktop),
    )

    await saveListingPreset(
      SITE,
      { ...DEFAULT_LISTING, departmentId: dept.id, columnsDesktop: 6, perPage: 48 },
      'test',
    )
    const overridden = await listingPresetFor(SITE, dept.id)
    ok('an override wins over the shop', overridden.columnsDesktop === 6, String(overridden.columnsDesktop))
    ok('and carries its own page size', overridden.perPage === 48, String(overridden.perPage))

    // The shop moving must NOT drag an override with it.
    await saveListingPreset(SITE, { ...DEFAULT_LISTING, departmentId: null, columnsDesktop: 2 }, 'test')
    const stillOverridden = await listingPresetFor(SITE, dept.id)
    ok('an override survives the shop changing', stillOverridden.columnsDesktop === 6)

    /*
     * Clearing is a DELETE, not a column reading "inherit" — so there is one way
     * to be following rather than two that have to agree.
     */
    await clearListingPreset(SITE, dept.id)
    const cleared = await listingPresetFor(SITE, dept.id)
    ok('clearing an override goes back to following', cleared.columnsDesktop === 2, String(cleared.columnsDesktop))
    ok('and leaves no row behind', !(await listListingPresets(SITE)).has(dept.id))
  }

  console.log('\n— Badges —')
  {
    ok('no rules and no label means no badges', badgesFor({}, DEFAULT_BADGE_RULES).length === 0)

    const manual = badgesFor({ onlineBadge: 'Halaal', onlineBadgeTone: 'success' }, DEFAULT_BADGE_RULES)
    ok('a hand-written badge shows', manual[0]?.label === 'Halaal' && manual[0]?.tone === 'success')

    // A tone is a MEANING, so an unknown one becomes the shop's own colour
    // rather than reaching a Badge that has no case for it.
    ok('an unknown tone falls back', safeBadgeTone('neon') === 'brand')

    const rules = { ...DEFAULT_BADGE_RULES, newLabel: 'New', newDays: 30, lowStockLabel: 'Almost gone', lowStockAt: 3 }
    ok('a new product earns its badge', badgesFor({ addedDaysAgo: 5 }, rules)[0]?.label === 'New')
    ok('an old one does not', badgesFor({ addedDaysAgo: 400 }, rules).length === 0)
    ok('low stock earns one', badgesFor({ stockOnHand: 2 }, rules)[0]?.label === 'Almost gone')
    // Sold out is the StockBadge's job — "almost gone" over nothing is a lie.
    ok('but nothing left does not', badgesFor({ stockOnHand: 0 }, rules).length === 0)

    /*
     * Capped at two. A product that is new AND low AND hand-labelled is not
     * unusual, and three badges on a 160px tile is the one nobody reads.
     */
    const crowded = badgesFor(
      { addedDaysAgo: 1, stockOnHand: 1, onlineBadge: 'Local', isBestSeller: true },
      { ...rules, bestSellerLabel: 'Best seller' },
    )
    ok('a tile wears at most two', crowded.length === MAX_TILE_BADGES, String(crowded.length))
    // Rules before the hand-written one: a rule badge is about the MOMENT, and
    // that is the one a shopper acts on.
    ok('and the timely one comes first', crowded[0]?.label === 'New', crowded.map((b) => b.label).join(','))
  }

  console.log('\n— Every vocabulary is complete —')
  {
    ok('every card field is a real string', CARD_FIELDS.every((f) => typeof f === 'string' && f.length > 0))
    ok('every facet is', LISTING_FACETS.every((f) => typeof f === 'string' && f.length > 0))
    ok('every page size divides a row evenly', PER_PAGE_CHOICES.every((n) => n % 12 === 0))
  }

  console.log('\n— Cleanup —')
  {
    await saveListingPreset(SITE, { ...shopBefore, departmentId: null }, 'test')
    if (hadOwnRow) await saveListingPreset(SITE, { ...deptBefore, departmentId: dept.id }, 'test')
    else await clearListingPreset(SITE, dept.id)

    const shopNow = await shopListingPreset(SITE)
    ok(
      'the shop is left as it was found',
      JSON.stringify(shopNow) === JSON.stringify(shopBefore),
      shopNow.columnsDesktop === shopBefore.columnsDesktop ? '' : 'columns differ',
    )
    ok('and the department is too', (await listListingPresets(SITE)).has(dept.id) === hadOwnRow)
  }

  console.log(fails ? `\n${fails} FAILED.` : '\nAll listing preset checks passed.')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

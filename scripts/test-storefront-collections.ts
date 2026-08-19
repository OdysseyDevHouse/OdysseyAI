/**
 * Collections: the rules, the picks, and the address they live at.
 *
 * ── WHAT THIS IS GUARDING ────────────────────────────────────────────────
 *
 * Two things that would each be invisible until a shopper found them. A slug
 * is a public address, so two collections sharing one is two pages at a single
 * URL and whichever the query returned first is the one somebody gets. And
 * every rule — including the hand-picked one — has to go through the publish
 * gates, or a merchant who unpublishes a product finds it still on a
 * collection page they cannot see the reason for.
 *
 *   npm run test:storefront-collections
 */
import {
  collectionBySlug,
  collectionPicks,
  collectionProducts,
  deleteCollection,
  getCollection,
  listCollections,
  publishedCollections,
  saveCollection,
  saveCollectionPicks,
} from '../src/lib/site/storefrontCollections'
import {
  COLLECTION_RULES,
  MAX_COLLECTION_PICKS,
  safeCollectionRule,
  slugify,
} from '../src/lib/storefront/collections'
import { publishedProducts, storefrontContext } from '../src/lib/site/storefront'
import { siteQuery } from '../src/lib/siteDb'

/*
 * Site 2, and the site number is the whole test.
 *
 * This suite needs products a SHOPPER can see. Site 1's shop publishes by
 * department and has none published, so `publishedProducts` returned an empty
 * list and the three assertions that pick from it had nothing to pick — the
 * fixture guard below is what said so out loud instead of passing vacuously.
 *
 * The sibling suites (menus, listing presets) stay on site 1 because neither
 * needs a published product.
 */
const SITE = 2
/** Every row this suite makes wears it, so cleanup finds exactly those. */
const TAG = 'zz-test-collection'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const base = {
  description: '',
  imageId: null,
  isPublished: true,
  sortOrder: 0,
  ruleValue: '',
  seoTitle: '',
  seoDescription: '',
}

async function cleanup() {
  for (const c of await listCollections(SITE)) {
    if (c.slug.startsWith(TAG)) await deleteCollection(SITE, c.id)
  }
}

async function main() {
  await cleanup()

  const context = await storefrontContext(SITE)
  if (!context) throw new Error('The shop must be open for this suite.')

  console.log('\n— A readable address —')
  {
    ok('a name becomes a slug', slugify('Gifts under R300') === 'gifts-under-r300')
    // Accents are stripped rather than encoded: "Café" becomes what somebody
    // actually types from a poster.
    ok('accents are folded', slugify('Café Favourites') === 'cafe-favourites')
    ok('punctuation goes', slugify("Mum's Choice") === 'mum-s-choice')
    ok('nothing usable is nothing', slugify('!!!') === '')

    const made = await saveCollection(
      SITE,
      null,
      { ...base, slug: `${TAG}-a`, title: 'First', rule: 'manual' },
      'test',
    )
    ok('a collection is created', made.ok, made.ok ? '' : made.error)
    if (!made.ok) return finish()

    /*
     * A slug is a public address. Two collections sharing one is two pages at a
     * single URL, and whichever the query returned first is the one a shopper
     * gets — which is not a thing anybody would notice until it mattered.
     */
    const clash = await saveCollection(
      SITE,
      null,
      { ...base, slug: `${TAG}-a`, title: 'Second', rule: 'manual' },
      'test',
    )
    ok('a duplicate address is refused', !clash.ok)

    // A title that reduces to nothing has no address, and inventing one would
    // give two such titles the same address.
    const unusable = await saveCollection(
      SITE,
      null,
      { ...base, slug: '', title: '!!!', rule: 'manual' },
      'test',
    )
    ok('a title with no letters is refused', !unusable.ok)

    const named = await saveCollection(
      SITE,
      null,
      { ...base, slug: '', title: `${TAG} Derived`, rule: 'manual' },
      'test',
    )
    ok('an empty slug is derived from the title', named.ok)
    if (named.ok) {
      const c = await getCollection(SITE, named.id)
      ok('and it is the slugified title', c?.slug === slugify(`${TAG} Derived`), c?.slug)
    }
  }

  console.log('\n— What a rule holds —')
  {
    const [dept] = await siteQuery<{ id: number }>(
      SITE,
      `SELECT department_id AS id FROM products
        WHERE show_online = 1 AND department_id IS NOT NULL LIMIT 1`,
    )

    for (const rule of COLLECTION_RULES) {
      const made = await saveCollection(
        SITE,
        null,
        {
          ...base,
          slug: `${TAG}-${rule}`,
          title: `${TAG} ${rule}`,
          rule,
          ruleValue: rule === 'department' ? String(dept?.id ?? 0) : '',
        },
        'test',
      )
      if (!made.ok) {
        ok(`rule ${rule} saves`, false, made.error)
        continue
      }
      const collection = await getCollection(SITE, made.id)
      const products = await collectionProducts(context, collection!, { limit: 5 })
      // Every rule must RESOLVE. Whether it finds anything depends on the
      // shop's data; whether it throws does not.
      ok(`rule ${rule} resolves`, Array.isArray(products), `${products.length} products`)
    }
  }

  console.log('\n— Hand-picked, and the publish gates —')
  {
    const made = await saveCollection(
      SITE,
      null,
      { ...base, slug: `${TAG}-picks`, title: `${TAG} picks`, rule: 'manual' },
      'test',
    )
    if (!made.ok) return finish()

    /*
     * What a SHOPPER can see, not what a flag says.
     *
     * A shop publishes by department OR by flag (`publish_mode`), and this one
     * publishes by department with `show_online = 0` on every product — so
     * selecting on the flag returned nothing, and two assertions below compared
     * an empty list against an empty list and passed while proving nothing.
     * `publishedProducts` is the one thing that knows the shop's own rule.
     */
    const visible = await publishedProducts(context, { limit: 3 })
    const published = visible.map((p) => ({ id: p.id }))
    const shownIds = new Set(published.map((p) => p.id))
    const [hiddenRow] = await siteQuery<{ id: number }>(
      SITE,
      `SELECT id FROM products WHERE is_archived = 0 ORDER BY id DESC LIMIT 50`,
    ).then((rows) => rows.filter((r) => !shownIds.has(Number(r.id))))
    const hidden = hiddenRow ? [hiddenRow] : []

    /*
     * Junk mixed in with the real ids. A stale one used to make the foreign key
     * refuse the whole transaction — so a merchant who arranged twenty
     * products, one of which somebody else deleted while they worked, lost all
     * twenty to an error naming a constraint.
     */
    await saveCollectionPicks(SITE, made.id, [
      ...published.map((p) => p.id),
      999999999,
      -1,
      0,
    ])
    const stored = await collectionPicks(SITE, made.id)
    // Said out loud, because the two checks below are vacuous over an empty
    // list — they would pass on a shop with nothing published and prove none
    // of what they claim.
    ok('the fixture has something to pick', published.length > 0, String(published.length))
    ok('the real picks are kept', stored.length === published.length, `${stored.length} of ${published.length}`)
    // The stale id was in the list; losing the rest to it is the bug.
    ok('a stale id does not lose the rest', stored.length === published.length && published.length > 0)
    ok('and the order is the merchant’s', stored.join(',') === published.map((p) => p.id).join(','))

    /*
     * The publish gates apply to a HAND-PICKED collection too. A merchant who
     * picks a product and later unpublishes it should watch it leave, not have
     * the pick override the rules — publishedProducts makes exactly this
     * argument for the page builder's picked rows.
     */
    if (hidden[0]) {
      await saveCollectionPicks(SITE, made.id, [...published.map((p) => p.id), hidden[0].id])
      const collection = await getCollection(SITE, made.id)
      const shown = await collectionProducts(context, collection!)
      ok(
        'an unpublished pick does not reach a shopper',
        !shown.some((p) => p.id === hidden[0].id),
        `${shown.length} shown of ${published.length + 1} picked`,
      )
    }

    const many = Array.from({ length: MAX_COLLECTION_PICKS + 20 }, (_, i) => published[0]?.id ?? i)
    await saveCollectionPicks(SITE, made.id, many)
    const capped = await collectionPicks(SITE, made.id)
    // De-duplicated as well as capped — the same id twice is one tile.
    ok('picks are de-duplicated', capped.length === 1, String(capped.length))
  }

  console.log('\n— Only a published collection has an address —')
  {
    const made = await saveCollection(
      SITE,
      null,
      { ...base, slug: `${TAG}-hidden`, title: `${TAG} hidden`, rule: 'special', isPublished: false },
      'test',
    )
    if (!made.ok) return finish()

    // An unpublished one resolves to nothing, so nobody can enumerate what a
    // shop is planning by trying addresses.
    ok('an unpublished collection is not reachable', (await collectionBySlug(SITE, `${TAG}-hidden`)) === null)
    ok('and it is not in the published list', !(await publishedCollections(SITE)).some((c) => c.id === made.id))
    ok('but the shop can still see it', (await listCollections(SITE)).some((c) => c.id === made.id))

    await saveCollection(SITE, made.id, { ...base, slug: `${TAG}-hidden`, title: `${TAG} hidden`, rule: 'special', isPublished: true }, 'test')
    ok('publishing gives it its address', (await collectionBySlug(SITE, `${TAG}-hidden`))?.id === made.id)
  }

  console.log('\n— Coercion —')
  {
    ok('an unknown rule reads as hand-picked', safeCollectionRule('vibes') === 'manual')
    ok('every declared rule survives its own check', COLLECTION_RULES.every((r) => safeCollectionRule(r) === r))
  }

  console.log('\n— Cleanup —')
  {
    const before = (await listCollections(SITE)).filter((c) => c.slug.startsWith(TAG))
    for (const c of before) await deleteCollection(SITE, c.id)

    const after = (await listCollections(SITE)).filter((c) => c.slug.startsWith(TAG))
    ok('every test collection is gone', after.length === 0, String(after.length))

    // The picks go with the collection — a leaked row would fail a later run
    // against its own leftovers.
    const orphans = await siteQuery<{ n: number }>(
      SITE,
      `SELECT COUNT(*) AS n FROM storefront_collection_products cp
         LEFT JOIN storefront_collections c ON c.id = cp.collection_id
        WHERE c.id IS NULL`,
    )
    ok('no picks left behind', Number(orphans[0]?.n) === 0, String(orphans[0]?.n))
  }

  finish()
}

function finish(): never {
  console.log(fails ? `\n${fails} FAILED.` : '\nAll collection checks passed.')
  process.exit(fails ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})

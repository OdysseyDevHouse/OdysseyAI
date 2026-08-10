/**
 * Folding variants into tiles — the pure logic the shop's grid depends on.
 *
 *   npx tsx scripts/test-variant-tiles.ts
 *
 * No database: groupVariants takes rows already fetched, which is exactly why
 * it lives outside the `server-only` storefront module and can be exercised
 * directly.
 *
 * What matters here:
 *
 *   · A group is ONE tile, and standalone products are untouched.
 *   · The representative is the cheapest IN-STOCK sibling — nominating a
 *     sold-out one advertises a price nobody can pay.
 *   · An all-sold-out group still appears, rather than vanishing from the shop
 *     with no explanation.
 *   · Incoming ORDER survives. The caller has already sorted by name, price or
 *     "featured", and a group that jumped position because of how it is stored
 *     would silently override the sort the shopper chose.
 *   · Re-folding an already-folded list changes nothing — the catalogue groups
 *     for its count and paging, then the grid groups again.
 */
import { groupVariants } from '../src/lib/variantTiles'
import type { StorefrontProduct } from '../src/lib/site/storefront'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

let nextId = 1
function product(
  description: string,
  priceIncl: number,
  inStock: boolean,
  group?: { parentId: number; groupName: string; axis1: string; sort: number },
): StorefrontProduct {
  return {
    id: nextId++,
    code: `C${nextId}`,
    description,
    departmentId: 1,
    departmentName: 'Clothing',
    priceIncl,
    inStock,
    stockOnHand: inStock ? 5 : 0,
    brand: null,
    wasPriceIncl: null,
    imageId: null,
    imageAlt: description,
    variantOf: group
      ? { parentId: group.parentId, groupName: group.groupName, axis1: group.axis1, axis2: '', sort: group.sort }
      : null,
  }
}

/* ── A group collapses to one tile ─────────────────────────────────────── */

const g = (axis1: string, sort: number) => ({ parentId: 100, groupName: 'Cotton T-Shirt', axis1, sort })

const shirts = [
  product('T-Shirt Small', 189, true, g('Small', 10)),
  product('T-Shirt Medium', 189, false, g('Medium', 20)),
  product('T-Shirt Large', 219, true, g('Large', 30)),
]

let tiles = groupVariants(shirts)
ok('a group of three is one tile', tiles.length === 1, String(tiles.length))
ok('  titled with the group name', tiles[0].title === 'Cotton T-Shirt', tiles[0].title)
ok('  carrying every sibling', tiles[0].siblings.length === 3, String(tiles[0].siblings.length))
ok('  priced from the cheapest', Math.abs(tiles[0].fromPriceIncl - 189) < 0.005, String(tiles[0].fromPriceIncl))
ok('  and knows the price varies', tiles[0].priceVaries)

/* ── The representative is cheapest IN STOCK ───────────────────────────── */

const cheapButGone = [
  product('T-Shirt Small', 99, false, g('Small', 10)),   // cheapest, sold out
  product('T-Shirt Medium', 189, true, g('Medium', 20)), // cheapest available
  product('T-Shirt Large', 219, true, g('Large', 30)),
]
tiles = groupVariants(cheapButGone)
ok(
  'the representative is the cheapest AVAILABLE sibling',
  tiles[0].product.description === 'T-Shirt Medium',
  tiles[0].product.description,
)
ok(
  '  while "from" still quotes the true lowest price',
  Math.abs(tiles[0].fromPriceIncl - 99) < 0.005,
  String(tiles[0].fromPriceIncl),
)

/* ── All sold out: the group still appears ─────────────────────────────── */

const allGone = [
  product('T-Shirt Small', 189, false, g('Small', 10)),
  product('T-Shirt Large', 219, false, g('Large', 30)),
]
tiles = groupVariants(allGone)
ok('an all-sold-out group still renders', tiles.length === 1)
ok('  represented by its cheapest', Math.abs(tiles[0].product.priceIncl - 189) < 0.005)

/* ── A group whose prices match says nothing about "from" ──────────────── */

const flat = [
  product('T-Shirt Small', 189, true, g('Small', 10)),
  product('T-Shirt Large', 189, true, g('Large', 30)),
]
ok('one price across a group is not a range', !groupVariants(flat)[0].priceVaries)

/* ── Standalone products are untouched ─────────────────────────────────── */

const mixed = [
  product('Mug', 79, true),
  product('T-Shirt Small', 189, true, g('Small', 10)),
  product('T-Shirt Large', 219, true, g('Large', 30)),
  product('Cap', 149, true),
]
tiles = groupVariants(mixed)
ok('standalone products stay their own tiles', tiles.length === 3, String(tiles.length))
ok('  and carry no siblings', tiles[0].siblings.length === 0)

/* ── Incoming order is preserved ───────────────────────────────────────── */

ok(
  'a group holds the position of its FIRST member',
  tiles.map((t) => t.title).join(' | ') === 'Mug | Cotton T-Shirt | Cap',
  tiles.map((t) => t.title).join(' | '),
)

/* ── Folding twice is folding once ─────────────────────────────────────── */

const once = groupVariants(mixed)
const flattened = once.flatMap((t) => (t.siblings.length > 0 ? t.siblings : [t.product]))
const twice = groupVariants(flattened)
ok(
  're-folding an already-folded list is stable',
  twice.length === once.length &&
    twice.map((t) => t.title).join('|') === once.map((t) => t.title).join('|'),
  `${once.length} then ${twice.length}`,
)

/* ── Two different groups do not merge ─────────────────────────────────── */

const twoGroups = [
  product('Tee S', 189, true, { parentId: 100, groupName: 'Tee', axis1: 'S', sort: 10 }),
  product('Hoodie S', 499, true, { parentId: 200, groupName: 'Hoodie', axis1: 'S', sort: 10 }),
  product('Tee L', 219, true, { parentId: 100, groupName: 'Tee', axis1: 'L', sort: 20 }),
]
tiles = groupVariants(twoGroups)
ok('two groups stay two tiles', tiles.length === 2, String(tiles.length))
ok(
  '  and each keeps its own siblings',
  tiles[0].siblings.length === 2 && tiles[1].siblings.length === 1,
  `${tiles[0].siblings.length}/${tiles[1].siblings.length}`,
)

/* ── Empty in, empty out ───────────────────────────────────────────────── */

ok('an empty catalogue folds to nothing', groupVariants([]).length === 0)

console.log(fails === 0 ? '\nAll tile checks passed.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)

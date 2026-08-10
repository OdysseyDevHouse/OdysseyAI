import type { StorefrontProduct } from './site/storefront'

/**
 * Folding a group's variants into one tile.
 *
 * Lives OUTSIDE site/storefront.ts, which is `server-only`, because the grid
 * that needs this is a client component. The logic is pure — it reads no
 * database and takes rows already fetched — so there is nothing here that has
 * to stay on the server, and importing the server module from the client would
 * fail at runtime even though the types erase cleanly.
 */

export type StorefrontTile = {
  /** The product a tile links to and prices from. */
  product: StorefrontProduct
  /**
   * Every sibling, in picker order, when this tile is a group. Empty for a
   * standalone product — a tile with one option is a picker that does nothing.
   */
  siblings: StorefrontProduct[]
  /** The group's shared name, or the product's own description. */
  title: string
  /** The lowest price in the group, for a "from R…" label. */
  fromPriceIncl: number
  /** True when siblings differ in price, so "from" is worth saying at all. */
  priceVaries: boolean
}

/**
 * What the grid actually draws: standalone products, and one entry per group.
 *
 * ── THE REPRESENTATIVE IS THE CHEAPEST IN-STOCK SIBLING ──────────────────
 *
 * A tile shows one price and one picture, so a group has to nominate a member.
 * Cheapest-in-stock, because "from R24.99" under a photograph of something you
 * can actually buy today is the honest version of a group — whereas nominating
 * a sold-out sibling advertises a price nobody can pay.
 *
 * When every sibling is out of stock the cheapest overall stands in, so the
 * group still appears and says "sold out" rather than vanishing from the shop
 * with no explanation.
 *
 * ── ORDER IS PRESERVED ───────────────────────────────────────────────────
 *
 * A group takes the position of its FIRST member in the incoming list. The
 * caller has already sorted — by name, by price, by "featured" — and a group
 * that jumped to the front because of how it happens to be stored would
 * quietly override the sort the shopper chose.
 */
export function groupVariants(products: StorefrontProduct[]): StorefrontTile[] {
  const tiles: StorefrontTile[] = []
  // Where each group landed, so later siblings join the tile already placed.
  const groupIndex = new Map<number, number>()

  for (const product of products) {
    const group = product.variantOf
    if (!group) {
      tiles.push({
        product,
        siblings: [],
        title: product.description,
        fromPriceIncl: product.priceIncl,
        priceVaries: false,
      })
      continue
    }

    const seen = groupIndex.get(group.parentId)
    if (seen === undefined) {
      groupIndex.set(group.parentId, tiles.length)
      tiles.push({
        product,
        siblings: [product],
        // Falls back to the child's own name: a group whose parent lost its
        // description should still title its tile with something readable.
        title: group.groupName || product.description,
        fromPriceIncl: product.priceIncl,
        priceVaries: false,
      })
      continue
    }
    tiles[seen].siblings.push(product)
  }

  // Second pass: nominate each group's representative and work out its range.
  for (const tile of tiles) {
    if (tile.siblings.length === 0) continue

    tile.siblings.sort(
      (a, b) =>
        (a.variantOf?.sort ?? 0) - (b.variantOf?.sort ?? 0) ||
        a.priceIncl - b.priceIncl ||
        a.description.localeCompare(b.description),
    )

    const cheapest = (list: StorefrontProduct[]) =>
      list.reduce((best, p) => (p.priceIncl < best.priceIncl ? p : best), list[0])

    const available = tile.siblings.filter((s) => s.inStock)
    tile.product = cheapest(available.length > 0 ? available : tile.siblings)

    const prices = tile.siblings.map((s) => s.priceIncl)
    tile.fromPriceIncl = Math.min(...prices)
    tile.priceVaries = Math.max(...prices) - tile.fromPriceIncl > 0.005
  }

  return tiles
}

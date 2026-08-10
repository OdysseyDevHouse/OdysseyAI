'use client'

import { useEffect, useState } from 'react'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { MAX_RECENT, readRecent } from '@/lib/recentlyViewed'
import { wishlistProductsAction } from './actions'
import ProductGrid from './ProductGrid'

/**
 * The last few things this shopper looked at.
 *
 * ── IT RENDERS NOTHING UNTIL THE BROWSER HAS SPOKEN ──────────────────────
 *
 * The list lives in localStorage, so the server has no idea what is in it —
 * which means this cannot be a server component and cannot render anything on
 * the first pass without causing a hydration mismatch. It starts empty and
 * fills in an effect.
 *
 * That also makes `sectionIsEmpty` unable to answer for this kind, which is
 * why it returns false there and the emptiness is decided HERE instead. See
 * the note on the 'recent' case.
 *
 * ── THE ANCHOR IS EXCLUDED ───────────────────────────────────────────────
 *
 * On a product page the shopper is, by definition, looking at the most
 * recently viewed product — so it would head its own "recently viewed" row.
 * `exclude` drops it.
 *
 * ── AND WHY IT REUSES THE WISHLIST'S ACTION ──────────────────────────────
 *
 * `wishlistProductsAction` is already "resolve these ids through the shop's
 * publish rules, dropping anything not for sale", which is exactly this
 * question. A second action doing the same thing is a second place for the
 * publish rules to be forgotten.
 */
export default function RecentlyViewed({
  token,
  title,
  exclude,
  display,
}: {
  token: string
  title: string
  /** A product to leave out — the one being looked at. */
  exclude?: number
  /** The shop's own display choices, passed straight to the tiles. */
  display: {
    layout: 'grid' | 'list'
    showStock: boolean
    showPhotos: boolean
    showBrands: boolean
  }
}) {
  const [products, setProducts] = useState<StorefrontProduct[] | null>(null)

  useEffect(() => {
    const ids = readRecent(token).filter((id) => id !== exclude)
    if (ids.length === 0) {
      setProducts([])
      return
    }

    let live = true
    wishlistProductsAction(token, ids.slice(0, MAX_RECENT)).then((found) => {
      // The tab may have navigated away while this was in flight; setting
      // state on a gone component is a warning nobody needs to read.
      if (!live) return
      /*
       * Back into the order they were VIEWED in.
       *
       * The action resolves by id and returns whatever the catalogue gives
       * back, which is not the browsing order — and "recently viewed" listed
       * in an arbitrary order is not recently viewed, it is a random row.
       */
      const byId = new Map(found.map((p) => [p.id, p]))
      setProducts(ids.map((id) => byId.get(id)).filter((p): p is StorefrontProduct => Boolean(p)))
    })
    return () => {
      live = false
    }
  }, [token, exclude])

  /*
   * Nothing at all until there is something worth showing.
   *
   * `null` is "not asked yet" and renders nothing rather than a heading over
   * an empty space that fills a moment later. One product is also not a row
   * worth a heading — it is the thing they just looked at.
   */
  if (!products || products.length < 2) return null

  return (
    <section>
      {title && <h2 className="mb-3 text-base font-semibold text-ink">{title}</h2>}
      <ProductGrid token={token} products={products} {...display} />
    </section>
  )
}

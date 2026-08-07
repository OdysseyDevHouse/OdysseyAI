'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button, EmptyState, Icons } from '@/components/ui'
import type { StorefrontProduct } from '@/lib/site/storefront'
import ProductGrid, { type ProductListLayout } from '../ProductGrid'
import { useWishlist } from '../WishlistContext'
import { wishlistProductsAction } from '../actions'

/**
 * The saved-for-later list.
 *
 * ── THE SAVED IDS ARE RESOLVED SERVER-SIDE ───────────────────────────────
 *
 * The list lives in this browser, so it is sent to an action that looks the
 * ids up through the shop's normal publish rules. Anything that does not come
 * back — unpublished, deleted, or an id someone typed into localStorage by
 * hand — simply drops out. That is both the stale-item behaviour AND the
 * security property: a tampered entry cannot surface a product the shop does
 * not publish.
 *
 * ── DISAPPEARING IS ACKNOWLEDGED, NOT SILENT ─────────────────────────────
 *
 * Someone who saved six things and sees four assumes the shop lost them. The
 * count of what no longer resolves is said out loud.
 */
export default function WishlistView({
  token,
  layout,
  showStock,
  showPhotos,
  showBrands,
}: {
  token: string
  layout: ProductListLayout
  showStock: boolean
  showPhotos: boolean
  showBrands: boolean
}) {
  const wishlist = useWishlist()
  const [products, setProducts] = useState<StorefrontProduct[] | null>(null)

  /*
   * Resolve whatever is saved, whenever it changes.
   *
   * Keyed on the id list rather than run once: removing an item here must not
   * leave the removed product on screen until a reload. The request sequence
   * guards against two resolves settling out of order.
   */
  const seq = useRef(0)
  const key = wishlist.ids.join(',')
  useEffect(() => {
    if (!wishlist.ready) return
    if (wishlist.ids.length === 0) {
      setProducts([])
      return
    }
    const mine = ++seq.current
    wishlistProductsAction(token, wishlist.ids).then((found) => {
      if (mine === seq.current) setProducts(found)
    })
    // `key` stands in for the array, which is a new reference every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wishlist.ready, token])

  const byId = new Map((products ?? []).map((p) => [p.id, p]))
  // The SHOPPER's order — newest first — not the catalogue's.
  const saved = wishlist.ids.map((id) => byId.get(id)).filter(Boolean) as StorefrontProduct[]
  // Deliberately different from `saved.length`. The gap is the stale count.
  const missing = wishlist.count - saved.length
  const loading = !wishlist.ready || products === null

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Your wishlist</h1>
        {!loading && saved.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => wishlist.clear()}>
            Clear all
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Saved on this device, so you can come back to them later.
      </p>

      <div className="mt-4">
        {/* Nothing at all until storage has been read. Rendering the empty
            state first would tell someone with a full list that it is gone. */}
        {loading ? null : saved.length === 0 ? (
          <EmptyState
            icon={<Icons.Heart size={22} />}
            title="Nothing saved yet"
            hint={
              missing > 0
                ? 'The items you saved aren’t available any more.'
                : 'Tap the heart on any product to keep it here for later.'
            }
            action={
              <Link href={`/store/${token}`}>
                <Button>Browse the shop</Button>
              </Link>
            }
          />
        ) : (
          <>
            {missing > 0 && (
              <p className="mb-3 text-sm text-muted">
                {missing === 1
                  ? 'One saved item isn’t available any more.'
                  : `${missing} saved items aren’t available any more.`}
              </p>
            )}
            <ProductGrid
              token={token}
              products={saved}
              layout={layout}
              showStock={showStock}
              showPhotos={showPhotos}
              showBrands={showBrands}
            />
          </>
        )}
      </div>
    </div>
  )
}

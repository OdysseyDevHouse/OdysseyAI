'use client'

import Link from 'next/link'
import { Badge, Button, Icons, useToast } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { useCart } from './CartContext'

/**
 * The catalogue grid.
 *
 * Each card is a link to the product with an "Add" button that does NOT
 * navigate — the common case is adding several things in a row, and bouncing
 * to a detail page after every tap is how a basket takes four times as long to
 * fill.
 *
 * Out of stock is shown but not orderable. Hiding it would make a shopper
 * think the shop does not carry the thing at all, and they would go elsewhere
 * rather than ask when it is back.
 */
export default function ProductGrid({
  token,
  products,
}: {
  token: string
  products: StorefrontProduct[]
}) {
  const cart = useCart()
  const toast = useToast()

  // items-stretch keeps every tile in a row the same height; the h-full on the
  // <li> is what makes its inner flex column fill that height rather than hug
  // its own content.
  return (
    <ul className="grid grid-cols-2 items-stretch gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <li
          key={product.id}
          className="flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card"
        >
          <Link
            href={`/store/${token}/p/${product.id}`}
            className="flex flex-1 flex-col gap-1 transition hover:bg-surface-2"
          >
            {/* ALWAYS rendered, even with no photograph.
                A tile that only reserved space when an image existed made
                every row as tall as its tallest member and left the others
                with a void between the name and the price — and a product
                with a photo sat visibly lower than one without. A fixed band
                keeps every tile the same shape.

                A plain <img>, not next/image: these are served by our own
                route behind a store token, and the optimiser would fetch and
                cache them itself, duplicating the publish check that route
                exists to enforce. */}
            <div className="flex h-36 w-full shrink-0 items-center justify-center overflow-hidden bg-surface-2">
              {product.imageId !== null ? (
                <img
                  src={`/api/store-images/${token}/${product.imageId}?p=${product.id}`}
                  alt={product.imageAlt}
                  loading="lazy"
                  // contain, not cover: a tall bottle and a wide box both fit
                  // whole rather than being cropped through the middle.
                  className="h-full w-full object-contain"
                />
              ) : (
                <Icons.Package size={28} className="text-faint" aria-hidden />
              )}
            </div>

            <span className="line-clamp-2 px-3 pt-3 text-sm font-medium text-ink">
              {product.description}
            </span>
            {product.departmentName && (
              <span className="line-clamp-1 px-3 text-xs text-muted">
                {product.departmentName}
              </span>
            )}
            <span className="numeric mt-auto px-3 pb-3 pt-2 text-base font-semibold text-ink">
              {formatMoney(product.priceIncl)}
            </span>
          </Link>

          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            {product.inStock ? (
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => {
                  cart.add({
                    productId: product.id,
                    code: product.code,
                    description: product.description,
                    priceIncl: product.priceIncl,
                  })
                  toast.success(`${product.description} added.`)
                }}
              >
                <Icons.Plus size={15} />
                Add
              </Button>
            ) : (
              <Badge tone="neutral">Out of stock</Badge>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

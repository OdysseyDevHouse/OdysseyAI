'use client'

import Link from 'next/link'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { formatMoney } from '@/lib/decimals'
import { Badge } from '@/components/ui'
import {
  AddControl,
  Price,
  ProductImage,
  Stars,
  StockBadge,
  savingPercent,
  stockState,
} from './ShopBits'

/**
 * How products are listed — everywhere.
 *
 * ── ONE COMPONENT, THREE OUTCOMES ────────────────────────────────────────
 *
 * The front page, a department, a search result and the related row all render
 * through here, deliberately: a product that looked different depending on how
 * a shopper arrived at it is a shop that looks assembled from parts.
 *
 *   grid  — full tiles with photographs
 *   rows  — a compact line per product, with a thumbnail
 *   rows  — the same, with no thumbnail, when the shop publishes no photos
 *
 * Grid REQUIRES photographs. A grid of lettermarks is a worse list than a list,
 * so a shop with photos switched off silently gets rows instead.
 *
 * ── THE TILE IS A LINK, THE BUTTONS ARE NOT ──────────────────────────────
 *
 * The whole card navigates to the product except the action row, which sits
 * outside the anchor. Adding to the basket from a listing is the common case —
 * bouncing to a detail page after every tap is how a basket takes four times
 * as long to fill.
 */

export type ProductListLayout = 'grid' | 'list'

export type ReviewSummary = { average: number; count: number }

export default function ProductGrid({
  token,
  products,
  layout = 'grid',
  showStock = false,
  showPhotos = true,
  showBrands = true,
  reviews,
}: {
  token: string
  products: StorefrontProduct[]
  layout?: ProductListLayout
  showStock?: boolean
  showPhotos?: boolean
  showBrands?: boolean
  /** Star ratings by product id. Absent means this listing shows no stars. */
  reviews?: Map<number, ReviewSummary>
}) {
  const asGrid = layout === 'grid' && showPhotos

  if (asGrid) {
    return (
      <ul className="grid grid-cols-2 items-stretch gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {products.map((product, i) => (
          <Tile
            key={product.id}
            token={token}
            product={product}
            showStock={showStock}
            showBrands={showBrands}
            review={reviews?.get(product.id)}
            // The first two are the phone's visible row, so they load eagerly
            // and everything below them waits until it is scrolled to.
            eager={i < 2}
          />
        ))}
      </ul>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {products.map((product) => (
        <Row
          key={product.id}
          token={token}
          product={product}
          showStock={showStock}
          showPhotos={showPhotos}
          review={reviews?.get(product.id)}
        />
      ))}
    </ul>
  )
}

function Tile({
  token,
  product,
  showStock,
  showBrands,
  review,
  eager,
}: {
  token: string
  product: StorefrontProduct
  showStock: boolean
  showBrands: boolean
  review?: ReviewSummary
  eager: boolean
}) {
  const soldOut = stockState(product, showStock) === 'out'
  const saving = savingPercent(product)

  return (
    <li
      className={
        // overflow-hidden is load-bearing: it clips the full-bleed photograph
        // to the card's own radius, so the image can sit edge to edge without
        // poking square corners out of a rounded card.
        'flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface ' +
        'shadow-card transition hover:-translate-y-0.5 hover:shadow-pop motion-reduce:transform-none'
      }
    >
      <Link href={`/store/${token}/p/${product.id}`} className="flex flex-1 flex-col">
        {/*
          4:3, not square, and FULL BLEED with no padding.
          Most catalogue photography is landscape, so a square crop throws away
          the sides of the thing being sold. The inset padding an earlier
          version had was the single biggest reason the shop read as a data
          table with pictures in it rather than as a shop.
        */}
        <span className="relative block w-full bg-surface-2" style={{ aspectRatio: '4 / 3' }}>
          <ProductImage
            token={token}
            product={product}
            eager={eager}
            // text-3xl only reaches the lettermark fallback — an <img> ignores
            // it. Sized here rather than in ShopBits because only this call
            // site knows how big its box is.
            className="absolute inset-0 h-full w-full text-3xl"
          />

          {/*
            Dims whatever is behind it — photograph or lettermark. The badge
            alone is too easy to miss at scrolling speed; the whole tile should
            read as unavailable.

            z-10 because the lettermark fallback is a SIBLING rendered before
            this, so without an explicit stacking order the scrim paints under
            it and a photoless sold-out tile looks perfectly available.
          */}
          {soldOut && <span className="absolute inset-0 z-10 bg-surface/60" aria-hidden />}

          {/* Above the scrim too — "Sold out" must stay legible on the tile
              the scrim is dimming. */}
          <span className="absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-col items-start gap-1">
            {product.departmentName && (
              <span className="truncate rounded-control bg-surface/90 px-2 py-1 text-xs font-medium uppercase tracking-wide text-ink backdrop-blur-sm">
                {product.departmentName}
              </span>
            )}
            {saving !== null && <Badge tone="danger">Save {saving}%</Badge>}
            <StockBadge product={product} showStock={showStock} />
          </span>
        </span>

        <span className="block px-3 pt-3">
          {showBrands && product.brand && (
            <span className="block truncate text-xs uppercase tracking-wide text-muted">
              {product.brand}
            </span>
          )}
          <span
            className={`line-clamp-2 block text-sm font-medium leading-tight text-ink ${
              showBrands && product.brand ? 'mt-0.5' : ''
            }`}
          >
            {product.description}
          </span>
          {review && review.count > 0 && (
            <span className="mt-1 block">
              <Stars value={review.average} count={review.count} />
            </span>
          )}
          <span className="mt-1.5 block">
            <Price product={product} />
          </span>
        </span>
      </Link>

      {/* mt-auto is essential: names wrap to one or two lines, and without it
          the buttons sit at different heights across a row. */}
      <div className="mt-auto flex items-center gap-2 px-3 pb-3 pt-2.5">
        <AddControl product={product} showStock={showStock} />
      </div>
    </li>
  )
}

function Row({
  token,
  product,
  showStock,
  showPhotos,
  review,
}: {
  token: string
  product: StorefrontProduct
  showStock: boolean
  showPhotos: boolean
  review?: ReviewSummary
}) {
  return (
    <li className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3">
      <Link href={`/store/${token}/p/${product.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        {showPhotos && (
          <ProductImage
            token={token}
            product={product}
            sizePx={52}
            className="rounded-control"
          />
        )}
        <span className="min-w-0 flex-1">
          {/* One line, truncated — a row is scanned, not read. The grid tile
              clamps to two because it has the width for a second. */}
          <span className="block truncate text-sm font-medium text-ink">
            {product.description}
          </span>
          {review && review.count > 0 && (
            <span className="mt-0.5 block">
              <Stars value={review.average} count={review.count} />
            </span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="numeric text-sm font-medium text-ink">
              {formatMoney(product.priceIncl)}
            </span>
            {product.wasPriceIncl !== null && (
              <span className="numeric text-xs text-muted line-through">
                {formatMoney(product.wasPriceIncl)}
              </span>
            )}
            <StockBadge product={product} showStock={showStock} />
          </span>
        </span>
      </Link>

      <AddControl product={product} showStock={showStock} compact />
    </li>
  )
}

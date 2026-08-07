'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge, Button, Icons } from '@/components/ui'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { AddControl, Price, Stars, initialsOf, savingPercent, stockState } from '../../ShopBits'
import { useCart } from '../../CartContext'

/**
 * One product, in full.
 *
 * ── THE GALLERY REPLACES THE TILE PICTURE, IT DOES NOT EXTEND IT ─────────
 *
 * The image shown on a tile is the product's primary picture, which is also
 * the first entry in the gallery. Prepending it would show the same photograph
 * twice — once as the main image and again as thumbnail one.
 *
 * ── THUMBNAILS ONLY WHEN THERE IS A CHOICE ──────────────────────────────
 *
 * A single thumbnail under the same big picture is a control that does
 * nothing, so with one photograph the strip is not drawn at all.
 */

export type GalleryImage = { id: number; altText: string }

export default function ProductDetail({
  token,
  product,
  images,
  showStock,
  showBrands,
  reviewAverage,
  reviewCount,
}: {
  token: string
  product: StorefrontProduct
  images: GalleryImage[]
  showStock: boolean
  showBrands: boolean
  reviewAverage: number
  reviewCount: number
}) {
  const [shown, setShown] = useState(0)
  const cart = useCart()

  const inBasket = cart.lines.find((l) => l.productId === product.id)?.qty ?? 0
  const saving = savingPercent(product)
  const state = stockState(product, showStock)

  /*
   * Clamped rather than trusted. This component stays mounted across a
   * navigation between two products, so an index left over from a product with
   * five photographs would blank the image on one with two.
   */
  const active = images[Math.min(shown, Math.max(0, images.length - 1))] ?? null

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={`/store/${token}`} className="font-medium text-brand hover:underline">
          Home
        </Link>
        {product.departmentName && product.departmentId !== null && (
          <>
            <Chevron />
            <Link
              href={`/store/${token}/c/${product.departmentId}`}
              className="font-medium text-brand hover:underline"
            >
              {product.departmentName}
            </Link>
          </>
        )}
        <Chevron />
        <span aria-current="page" className="min-w-0 truncate font-medium text-ink">
          {product.description}
        </span>
      </nav>

      {/* The buy panel is the WIDER column. The photograph sells the thing,
          but the price, the stock line and the button are what the shopper
          came to act on. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-center rounded-card border border-border bg-surface p-4">
            {/* Capped as well as proportional. On a wide screen the 5/6 column
                is wide enough that a square image becomes a 700px-tall panel,
                which pushes the price and the Add button off the fold — the
                two things the page exists to show. */}
            <div className="w-full max-w-sm">
              {active ? (
                <img
                  src={`/api/store-images/${token}/${active.id}?p=${product.id}`}
                  alt={active.altText || product.description}
                  loading="eager"
                  fetchPriority="high"
                  className="aspect-square w-full rounded-card bg-surface-2 object-contain"
                />
              ) : (
                <div
                  className="flex aspect-square w-full items-center justify-center rounded-card bg-brand-soft text-4xl font-semibold text-brand"
                  aria-hidden
                >
                  {initialsOf(product.description)}
                </div>
              )}
            </div>
          </div>

          {images.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Pictures of ${product.description}`}>
              {images.map((image, i) => (
                <button
                  key={image.id}
                  type="button"
                  aria-pressed={i === shown}
                  aria-label={`Show picture ${i + 1} of ${images.length}`}
                  onClick={() => setShown(i)}
                  /* Not a kit Button: this is a 64px picture swatch whose only
                     content is an image, and every Button variant would impose
                     its own padding and background on top of the photograph. */
                  data-kit-ok
                  className={`overflow-hidden rounded-control border-2 transition ${
                    i === shown ? 'border-brand opacity-100' : 'border-border opacity-70 hover:opacity-100'
                  }`}
                >
                  <img
                    src={`/api/store-images/${token}/${image.id}?p=${product.id}`}
                    alt=""
                    loading="lazy"
                    className="h-16 w-16 bg-surface-2 object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {product.departmentName && product.departmentId !== null && (
              <Link
                href={`/store/${token}/c/${product.departmentId}`}
                className="rounded-control bg-brand-soft px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-brand hover:underline"
              >
                {product.departmentName}
              </Link>
            )}
            {saving !== null && <Badge tone="danger">Save {saving}%</Badge>}
          </div>

          {showBrands && product.brand && (
            <p className="mt-2 text-xs uppercase tracking-wide text-muted">{product.brand}</p>
          )}

          <h1 className="mt-2 text-xl font-semibold leading-tight text-ink">
            {product.description}
          </h1>

          {reviewCount > 0 && (
            <p className="mt-2">
              <Stars value={reviewAverage} count={reviewCount} />
            </p>
          )}

          <p className="mt-3">
            <Price product={product} size="lg" />
          </p>

          {/* Only when the shop publishes stock. Without it, availability is
              carried by the Add button turning into "Sold out" instead.

              Three states, three colours: "Only 3 left" under a green tick
              reads as reassurance, when the whole point of saying it is to
              tell someone to decide now. */}
          {showStock && (
            <p
              className={`mt-2 flex items-center gap-1.5 text-sm font-medium ${
                state === 'out' ? 'text-danger' : state === 'low' ? 'text-warning' : 'text-success'
              }`}
            >
              {state === 'out' ? (
                <Icons.Close size={16} />
              ) : state === 'low' ? (
                <Icons.StatusWarning size={16} />
              ) : (
                <Icons.Check size={16} />
              )}
              {state === 'out'
                ? 'Sold out'
                : state === 'low'
                  ? `Only ${product.stockOnHand} left`
                  : 'In stock'}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="min-w-[9rem] flex-1">
              <AddControl product={product} showStock={showStock} />
            </div>
            {inBasket > 0 && (
              <Link href={`/store/${token}/checkout`}>
                <Button variant="secondary">Go to checkout</Button>
              </Link>
            )}
          </div>

          {inBasket > 0 && (
            <p className="mt-2 text-sm text-muted">{inBasket} in your basket.</p>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <TrustTile
              icon={<Icons.Check size={20} />}
              title="Checked before it goes out"
              body="Picked and packed by the shop"
            />
            <TrustTile
              icon={<Icons.Lock size={20} />}
              title="No card details here"
              body="You settle up with the shop"
            />
          </div>

          <p className="mt-5 text-sm text-muted">
            Product code <span className="numeric text-ink-2">{product.code}</span>
          </p>
        </div>
      </div>
    </div>
  )
}

function Chevron() {
  return <Icons.ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
}

function TrustTile({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-card bg-surface-2 p-3">
      <span className="shrink-0 text-brand">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
      </span>
    </div>
  )
}

'use client'

import { Badge, Button, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { useCart } from './CartContext'

/**
 * The small parts every storefront screen is built from.
 *
 * These live here rather than in `@/components/ui` because they are shop
 * furniture, not back-office furniture: a stepper that mutates a basket and a
 * star row for customer reviews have no meaning on a stock-take screen, and
 * putting them in the shared kit would mean every back-office import pulled in
 * the cart context.
 *
 * They still wear the kit's tokens, so restyling the app restyles the shop.
 */

/** Below five, say how many are left. Above it, "in stock" is enough. */
export const LOW_STOCK_AT = 5

export type StockState = 'out' | 'low' | 'ok'

/**
 * How available a product is, as one word.
 *
 * `showStock` off means the shop does not publish stock levels at all — in
 * which case everything reads as available rather than as unknown. A shop
 * that hides its stock still wants its products orderable.
 */
export function stockState(product: StorefrontProduct, showStock: boolean): StockState {
  if (!showStock) return 'ok'
  if (!product.inStock) return 'out'
  if (product.stockOnHand !== null && product.stockOnHand <= LOW_STOCK_AT) return 'low'
  return 'ok'
}

/** Nothing at all when a product is simply in stock — a badge per tile is noise. */
export function StockBadge({
  product,
  showStock,
}: {
  product: StorefrontProduct
  showStock: boolean
}) {
  const state = stockState(product, showStock)
  if (state === 'ok') return null
  if (state === 'out') return <Badge tone="danger">Sold out</Badge>
  return <Badge tone="warning">Only {product.stockOnHand} left</Badge>
}

/**
 * The percentage off, for a product with a was-price.
 *
 * Derived, never stored: a "20% off" typed by hand goes stale the moment
 * either price moves, and a shopper who spots the arithmetic not working
 * stops believing the rest of the page.
 */
export function savingPercent(product: StorefrontProduct): number | null {
  const was = product.wasPriceIncl
  if (!was || was <= product.priceIncl) return null
  return Math.round(((was - product.priceIncl) / was) * 100)
}

/**
 * Up to two initials, for a product with no photograph.
 *
 * A tinted lettermark rather than a broken-image icon or an empty grey box:
 * it gives the tile the same visual weight as its neighbours and reads as
 * deliberate rather than as a page that failed to load.
 */
export function initialsOf(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function ProductImage({
  token,
  product,
  className = '',
  sizePx,
  eager = false,
}: {
  token: string
  product: StorefrontProduct
  className?: string
  /** Only for the fixed-size square variant; the fluid one fills its box. */
  sizePx?: number
  eager?: boolean
}) {
  const style = sizePx ? { width: sizePx, height: sizePx } : undefined

  if (product.imageId === null) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center bg-brand-soft font-semibold text-brand ${className}`}
        style={{
          ...style,
          /*
           * Scaled to the box. A fixed-size mark leaves two small letters
           * adrift in a large empty tile, which reads as a picture that failed
           * to load rather than as a deliberate placeholder. In the fluid case
           * there is no pixel size to scale from, so `em` inherits from the
           * tile — hence the explicit size class at that call site.
           */
          fontSize: sizePx ? Math.max(11, sizePx * 0.34) : undefined,
        }}
        aria-hidden
      >
        {initialsOf(product.description)}
      </span>
    )
  }

  /*
   * A plain <img>, not next/image: these are served by our own route behind a
   * store token, and the optimiser would fetch and cache them itself,
   * duplicating the publish check that route exists to enforce.
   */
  return (
    <img
      src={`/api/store-images/${token}/${product.imageId}?p=${product.id}`}
      alt={product.imageAlt}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : undefined}
      decoding="async"
      style={style}
      className={`shrink-0 bg-surface-2 object-cover ${className}`}
    />
  )
}

/**
 * Add to basket, and then adjust the quantity in place.
 *
 * ── ONE COMPONENT, THREE STATES ──────────────────────────────────────────
 *
 * Sold out, not yet added, and added. Written as one component with a `compact`
 * prop rather than two, so the sold-out rule and the stepper can never drift
 * between the grid and the list.
 *
 * ── THE STEPPER MUTATES THE BASKET DIRECTLY ──────────────────────────────
 *
 * There is no staged quantity and no separate confirm. Tapping + adds one.
 * Tapping − to zero removes the line and the control reverts to "Add", which
 * is why there is no separate remove button on a tile.
 *
 * ── SOLD OUT IS NOT A CAP ────────────────────────────────────────────────
 *
 * A product already in the basket keeps its stepper even if it goes out of
 * stock, and + is never clamped against stock on hand. Stock here is a display
 * guard, not a reservation — staff confirm what they can actually supply when
 * they accept the order, and silently emptying someone's basket is worse than
 * a conversation at the counter.
 */
export function AddControl({
  product,
  showStock,
  compact = false,
}: {
  product: StorefrontProduct
  showStock: boolean
  compact?: boolean
}) {
  const cart = useCart()
  const qty = cart.lines.find((l) => l.productId === product.id)?.qty ?? 0
  const soldOut = stockState(product, showStock) === 'out'

  if (soldOut && qty === 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className={compact ? '' : 'w-full'}
        aria-label={`${product.description} is sold out`}
      >
        Sold out
      </Button>
    )
  }

  if (qty === 0) {
    return (
      <Button
        variant={compact ? 'secondary' : 'primary'}
        size="sm"
        className={compact ? '' : 'w-full'}
        aria-label={`Add ${product.description}`}
        onClick={() =>
          cart.add({
            productId: product.id,
            code: product.code,
            description: product.description,
            priceIncl: product.priceIncl,
          })
        }
      >
        <Icons.Plus size={15} />
        {/* The word goes at the narrowest widths and the icon carries it —
            two tiles per row on a small phone leaves no space for both. */}
        <span className={compact ? '' : 'hidden min-[380px]:inline'}>
          {compact ? 'Add' : 'Add to cart'}
        </span>
      </Button>
    )
  }

  return (
    <div className={`flex items-center gap-1 ${compact ? '' : 'w-full justify-between'}`}>
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        aria-label={`One fewer ${product.description}`}
        onClick={() => cart.setQty(product.id, qty - 1)}
      >
        <Icons.Minus size={15} />
      </Button>
      <span className="numeric min-w-6 text-center text-sm font-medium text-ink">{qty}</span>
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        aria-label={`One more ${product.description}`}
        onClick={() => cart.setQty(product.id, qty + 1)}
      >
        <Icons.Plus size={15} />
      </Button>
    </div>
  )
}

/**
 * A rating, as five stars.
 *
 * Half stars are done with OPACITY rather than by clipping a glyph: a clipped
 * ★ needs a second absolutely-positioned copy and a width calculation, and at
 * 13px the difference is invisible while the bug surface is not.
 *
 * Only ever rendered when there are approved reviews. A placeholder "4.8 (128)"
 * on a shop nobody has reviewed misleads a real shopper.
 */
export function Stars({ value, count }: { value: number; count?: number }) {
  const rounded = Math.round(value * 2) / 2
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`Rated ${value.toFixed(1)} out of 5${count ? ` from ${count} reviews` : ''}`}
    >
      <span aria-hidden className="text-warning">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            style={{ opacity: rounded >= i ? 1 : rounded >= i - 0.5 ? 0.55 : 0.25 }}
          >
            ★
          </span>
        ))}
      </span>
      <span className="text-xs text-muted">
        {value.toFixed(1)}
        {count ? ` (${count})` : ''}
      </span>
    </span>
  )
}

/** The price, with the old one struck through when there is a saving. */
export function Price({
  product,
  size = 'md',
}: {
  product: StorefrontProduct
  size?: 'md' | 'lg'
}) {
  const onSpecial = savingPercent(product) !== null
  return (
    <span className="flex flex-wrap items-baseline gap-1.5">
      <span
        className={`numeric font-semibold ${size === 'lg' ? 'text-2xl' : 'text-base'} ${
          // Red for a reduced price, brand for a normal one. The colour is the
          // fastest signal that something is on special — faster than reading
          // the struck-through figure beside it.
          onSpecial ? 'text-danger' : 'text-brand'
        }`}
      >
        {formatMoney(product.priceIncl)}
      </span>
      {onSpecial && (
        <span className="numeric text-xs text-muted line-through">
          {formatMoney(product.wasPriceIncl!)}
        </span>
      )}
    </span>
  )
}

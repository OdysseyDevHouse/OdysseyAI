'use client'

import { Badge, Button, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import { useCart } from './CartContext'
import { useWishlist } from './WishlistContext'

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
 * A department's picture, or the tile drawn when it has none.
 *
 * ── ONE COMPONENT, TWO PLACES ────────────────────────────────────────────
 *
 * The rail under the search and the "Shop by department" tiles both draw
 * through this. They are different sizes and different shapes, which is why
 * the caller supplies the classes — but "which picture, and what if there
 * isn't one" is one rule, stated once.
 *
 * ── THE FALLBACK IS NOT AN EMPTY BOX ─────────────────────────────────────
 *
 * A shop turning this on will be part way through adding pictures, so a
 * department without one is the normal case rather than a fault. It gets the
 * department's own colour and its initial — the same lettermark idea products
 * already use — so a half-finished row still reads as a row of tiles rather
 * than as a page that failed to load.
 */
export function DepartmentImage({
  department,
  className = '',
  src,
  rounded = 'rounded-card',
}: {
  department: Pick<StorefrontDepartment, 'id' | 'name' | 'imageId' | 'color'>
  /** The box it fills. Set by the caller — the rail and the tiles differ. */
  className?: string
  /**
   * The resolved URL for the picture, or null when there is none.
   *
   * ── A STRING, NOT THE `imageSrc` FUNCTION THE BANNERS TAKE ───────────
   *
   * This is a CLIENT component and `HomeSections` is a server one, so a
   * function prop cannot cross the boundary between them — React refuses it at
   * request time with "Functions cannot be passed directly to Client
   * Components", and both `tsc` and `next build` pass on it regardless. The
   * banner's `ImageSrc` works only because everything it passes through stays
   * on one side.
   *
   * So the caller — which already knows whether it is the shop or the builder
   * — resolves the URL and hands over the answer.
   */
  src: string | null
  rounded?: string
}) {
  // No picture, or one whose URL the caller could not resolve — the same
  // answer either way, which is what makes "deleted" and "never set"
  // indistinguishable here on purpose.
  if (department.imageId === null || src === null) {
    /*
     * The department's OWN colour, mixed down for the fill and used at full
     * strength for the letter. Inline because the value is the shop's data — a
     * department's colour is a hex the owner picked, not a design token — and
     * it is validated to a hex on the way in by validateDepartment.
     *
     * No colour set falls back to the brand tint, which is exactly what the
     * product lettermark does, so the two placeholders match.
     */
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center font-semibold ${rounded} ${className} ${
          department.color ? '' : 'bg-brand-soft text-brand'
        }`}
        style={
          department.color
            ? {
                background: `color-mix(in srgb, ${department.color} 18%, transparent)`,
                color: department.color,
              }
            : undefined
        }
      >
        {initialsOf(department.name)}
      </span>
    )
  }

  /* A plain <img> for the same reason as a product's — see ProductImage. */
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={`shrink-0 bg-surface-2 object-cover ${rounded} ${className}`}
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
 * Save for later.
 *
 * ── NOTHING IS ANNOUNCED ─────────────────────────────────────────────────
 *
 * No toast. The heart filling IS the confirmation, and a toast per heart
 * across a grid of forty products is noise. The count in the masthead is the
 * quieter second signal.
 *
 * ── THE LABEL DOES NOT CHANGE, THE FILL DOES ─────────────────────────────
 *
 * `aria-pressed` carries the state, so a screen reader announces "pressed"
 * rather than the label changing under someone mid-sentence. The visible
 * difference is the fill.
 */
export function FavouriteButton({ product }: { product: StorefrontProduct }) {
  const wishlist = useWishlist()
  // Gated on `ready`: before storage has been read every heart would render
  // empty and then pop full, which reads as the page losing the list.
  const saved = wishlist.ready && wishlist.has(product.id)

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-pressed={saved}
      aria-label={
        saved ? `Remove ${product.description} from your wishlist` : `Save ${product.description} for later`
      }
      title={saved ? 'Saved — tap to remove' : 'Save for later'}
      className={saved ? 'text-danger' : 'text-muted'}
      onClick={() => wishlist.toggle(product.id)}
    >
      <Icons.Heart size={18} fill={saved ? 'currentColor' : 'none'} />
    </Button>
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

import 'server-only'
import { absoluteUrl } from '../appUrl'
import type { OnlineSettings } from './onlineStore'
import type { StorefrontProduct } from './storefront'

/**
 * Whether a storefront may be indexed, and what it should tell a crawler.
 *
 * ── ONE PLACE DECIDES ────────────────────────────────────────────────────
 *
 * Three pages set `robots` today — the layout, the product page and the order
 * tracker — and a fourth will exist next month. Each deciding for itself is how
 * a shop ends up indexed on its product pages and not its front page, or worse,
 * how the order tracker gets indexed because somebody copied the wrong default.
 *
 * ── SOME PAGES ARE NEVER INDEXED, WHATEVER THE SHOP SAYS ─────────────────
 *
 * The opt-in covers the catalogue: the front page, departments, products. It
 * does NOT cover checkout, the account page, a saved basket or an order
 * tracker. Those either say nothing useful to a searcher or contain one
 * person's name and address, and no setting should be able to publish them —
 * which is why `neverIndex` is a separate function rather than a flag someone
 * can pass wrongly.
 */

/** What a page hands to Next's `robots` field. */
export type RobotsDirective = { index: boolean; follow: boolean }

/** Never indexed, whatever the shop has chosen. */
export const NEVER_INDEXED: RobotsDirective = { index: false, follow: false }

/**
 * The directive for a CATALOGUE page — front page, department, product.
 *
 * `follow` tracks `index` rather than staying true: a shop that has not opted
 * in does not want a crawler walking its catalogue either, and "don't index me
 * but do read everything I link to" is a distinction without a difference for
 * a storefront.
 */
export function catalogueRobots(settings: OnlineSettings): RobotsDirective {
  return settings.allowIndexing
    ? { index: true, follow: true }
    : { index: false, follow: false }
}

/**
 * The absolute address of a storefront path, on the shop's OWN domain when it
 * has told us one.
 *
 * The storefront lives behind an opaque signed token, so there is no readable
 * URL to derive — only the shop knows which domain points here. With no domain
 * set this falls back to APP_URL, which still produces a working canonical on
 * the platform host; with neither, null, and the caller omits the tag rather
 * than emitting a relative canonical (which browsers and crawlers both read as
 * "this page is canonical to itself", making the tag pointless).
 */
export function storefrontUrl(settings: OnlineSettings, path: string): string | null {
  const clean = path.startsWith('/') ? path : `/${path}`
  if (settings.publicDomain) return `https://${settings.publicDomain}${clean}`
  return absoluteUrl(clean)
}

/**
 * Product structured data, as schema.org JSON-LD.
 *
 * ── ONLY WHEN THE SHOP IS INDEXED ────────────────────────────────────────
 *
 * Structured data on a noindex page is markup nobody reads. More to the point,
 * `price` and `availability` are exactly the figures a shop that opted OUT was
 * declining to publish, and emitting them in a script tag would publish them
 * anyway to anyone who viewed source.
 *
 * ── AVAILABILITY IS THE SELLABLE FIGURE ──────────────────────────────────
 *
 * `inStock` already accounts for stock holds (076), so a product every one of
 * which is spoken for is advertised to Google as out of stock — the same answer
 * a shopper gets. A listing that promises stock the shop cannot supply is worse
 * than no listing.
 */
export function productJsonLd(
  settings: OnlineSettings,
  product: StorefrontProduct,
  opts: { url: string | null; storeName: string; imageUrl?: string | null },
): Record<string, unknown> | null {
  if (!settings.allowIndexing) return null

  const offer: Record<string, unknown> = {
    '@type': 'Offer',
    price: product.priceIncl.toFixed(2),
    priceCurrency: 'ZAR',
    availability: product.inStock
      ? 'https://schema.org/InStock'
      : 'https://schema.org/OutOfStock',
    seller: { '@type': 'Organization', name: opts.storeName },
  }
  if (opts.url) offer.url = opts.url

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.description,
    // The shop's own code. `sku` is what a merchant feed matches on, and it is
    // already printed on the product page, so this publishes nothing new.
    sku: product.code,
    offers: offer,
  }

  if (product.brand) data.brand = { '@type': 'Brand', name: product.brand }
  if (opts.imageUrl) data.image = opts.imageUrl
  return data
}

import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import {
  axisLabelsFor,
  publishedProduct,
  publishedProducts,
  siblingsOf,
  storefrontContext,
} from '@/lib/site/storefront'
import { catalogueRobots, productJsonLd, storefrontUrl } from '@/lib/site/storefrontSeo'
import { approvedReviewsFor } from '@/lib/site/productReviews'
import { listImages } from '@/lib/site/productImages'
import { formatMoney } from '@/lib/decimals'
import { Stars } from '../../ShopBits'
import ProductGrid from '../../ProductGrid'
import TrackEvent from '../../TrackEvent'
import ProductDetail from './ProductDetail'
import ReviewForm from './ReviewForm'

/**
 * One product.
 *
 * Resolved through `publishedProduct`, which applies the store's publish rules
 * — so a product the shop has not published 404s here even if someone guesses
 * its id, rather than being merely absent from the listing.
 */

export const dynamic = 'force-dynamic'

async function resolve(token: string, productId: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  const context = await storefrontContext(siteId)
  if (!context) return null
  const id = Number(productId)
  if (!Number.isInteger(id) || id <= 0) return null
  const product = await publishedProduct(context, id)
  if (!product) return null
  return { context, product }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; productId: string }>
}): Promise<Metadata> {
  const { token, productId } = await params
  const found = await resolve(token, productId)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  const { context, product } = found

  /*
   * The canonical points at the variant's OWN page, not the group's.
   *
   * Each size is a real product with its own price and stock, so each page is
   * genuinely distinct — pointing them all at one representative would ask
   * search engines to drop the pages a shopper searching "large" should land
   * on. The sitemap lists one url per group for discovery; this says each page
   * is itself.
   */
  const canonical = storefrontUrl(context.settings, `/store/${token}/p/${product.id}`)

  return {
    title: `${product.description} · ${context.storeName}`,
    description: `${product.description} — ${formatMoney(product.priceIncl)} at ${context.storeName}.`,
    // The shop's own choice, decided in one place so this page and the front
    // page can never disagree — see storefrontSeo.ts.
    robots: catalogueRobots(context.settings),
    ...(canonical ? { alternates: { canonical } } : {}),
  }
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ token: string; productId: string }>
}) {
  const { token, productId } = await params
  const found = await resolve(token, productId)
  if (!found) notFound()

  const { context, product } = found
  const { settings, siteId } = context

  // Only APPROVED reviews, and only when the shop has switched them on.
  const [reviews, images, related] = await Promise.all([
    settings.reviewsEnabled
      ? approvedReviewsFor(siteId, product.id)
      : Promise.resolve({ reviews: [], average: 0, count: 0 }),
    listImages(siteId, product.id),
    product.departmentId === null
      ? Promise.resolve([])
      : publishedProducts(context, { departmentId: product.departmentId, limit: 6 }),
  ])

  // Never suggest the thing already being looked at.
  const alsoLike = related.filter((p) => p.id !== product.id).slice(0, 5)

  /*
   * The other sizes/colours of this thing, and what those axes are called.
   *
   * Fetched after the product because both need its parent. A standalone
   * product costs one cheap no-op: siblingsOf returns [] without querying, and
   * the labels are skipped entirely.
   */
  const siblings = await siblingsOf(context, product)
  const axisLabels =
    product.variantOf && siblings.length > 1
      ? await axisLabelsFor(siteId, product.variantOf.parentId)
      : []

  /*
   * Structured data, only for a shop that has opted into being indexed.
   *
   * Null otherwise — and that matters beyond tidiness: price and availability
   * are exactly the figures a shop declining to be listed was declining to
   * publish, and a script tag would publish them to anyone viewing source.
   */
  const jsonLd = productJsonLd(settings, product, {
    url: storefrontUrl(settings, `/store/${token}/p/${product.id}`),
    storeName: context.storeName,
    imageUrl: product.imageId
      ? storefrontUrl(settings, `/api/store-images/${token}/${product.imageId}?p=${product.id}`)
      : null,
  })

  return (
    <div className="flex flex-col gap-10">
      {jsonLd && (
        /* JSON.stringify escapes nothing dangerous for a script context except
           `</script>` inside a string value — a product called "</script>" is
           the one input that could break out, so the closing tag is neutralised
           rather than trusted. */
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
          }}
        />
      )}

      {/* The top of the funnel. Client-side rather than counted here, so a
          crawler, a link preview or a prefetch does not register as a shopper
          looking at something. */}
      <TrackEvent token={token} kind="view" productId={product.id} />

      <ProductDetail
        token={token}
        product={product}
        images={images.map((i) => ({ id: i.id, altText: i.altText }))}
        showStock={settings.showStock}
        showBrands={settings.showBrands}
        reviewAverage={reviews.average}
        reviewCount={reviews.count}
        siblings={siblings}
        axisLabels={axisLabels}
      />

      {settings.reviewsEnabled && (
        <section>
          <h2 className="text-base font-semibold text-ink">Reviews</h2>

          {reviews.reviews.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No reviews yet — be the first to say what you thought.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {reviews.reviews.map((review) => (
                <li key={review.id} className="rounded-card border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Stars value={review.rating} />
                    <span className="text-sm font-medium text-ink">{review.title || 'Review'}</span>
                  </div>
                  {review.body && (
                    <p className="mt-2 whitespace-pre-line text-sm text-ink-2">{review.body}</p>
                  )}
                  <p className="mt-2 text-xs text-muted">{review.authorName || 'A customer'}</p>
                </li>
              ))}
            </ul>
          )}

          <ReviewForm token={token} productId={product.id} />
        </section>
      )}

      {alsoLike.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-ink">You may also like</h2>
          {/* Forced to grid regardless of the shop's list/grid preference: a
              suggestion strip is browsed by eye, and a row of names is not. */}
          <ProductGrid
            token={token}
            products={alsoLike}
            layout="grid"
            showStock={settings.showStock}
            showPhotos={settings.showPhotos}
            showBrands={settings.showBrands}
          />
        </section>
      )}
    </div>
  )
}

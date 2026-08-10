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
import { approvedReviewsFor } from '@/lib/site/productReviews'
import { listImages } from '@/lib/site/productImages'
import { formatMoney } from '@/lib/decimals'
import { Stars } from '../../ShopBits'
import ProductGrid from '../../ProductGrid'
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
  return {
    title: `${product.description} · ${context.storeName}`,
    description: `${product.description} — ${formatMoney(product.priceIncl)} at ${context.storeName}.`,
    robots: { index: false, follow: false },
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

  return (
    <div className="flex flex-col gap-10">
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

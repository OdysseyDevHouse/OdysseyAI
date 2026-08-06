import { notFound } from 'next/navigation'
import Link from 'next/link'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { publishedProduct, storefrontContext } from '@/lib/site/storefront'
import { approvedReviewsFor } from '@/lib/site/productReviews'
import { listImages } from '@/lib/site/productImages'
import { Badge, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import AddToBasket from './AddToBasket'

/**
 * One product.
 *
 * Resolved through `publishedProduct`, which applies the store's publish rules
 * — so a product the shop has not published 404s here even if someone guesses
 * its id, rather than being merely absent from the listing.
 */

export const dynamic = 'force-dynamic'

export default async function ProductPage({
  params,
}: {
  params: Promise<{ token: string; productId: string }>
}) {
  const { token, productId } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const id = Number(productId)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const product = await publishedProduct(context, id)
  if (!product) notFound()

  // Only APPROVED reviews, and only when the shop has switched them on.
  const [reviews, images] = await Promise.all([
    context.settings.reviewsEnabled
      ? approvedReviewsFor(siteId, id)
      : Promise.resolve({ reviews: [], average: 0, count: 0 }),
    listImages(siteId, id),
  ])

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/store/${token}`}
        className="flex items-center gap-1.5 text-sm text-muted transition hover:text-ink"
      >
        <Icons.ArrowLeft size={15} />
        Back to the shop
      </Link>

      {images.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image, index) => (
            <li key={image.id}>
              <img
                src={`/api/store-images/${token}/${image.id}?p=${product.id}`}
                alt={image.altText || product.description}
                /* The first picture is what the shopper came to see, so it is
                   fetched eagerly; the rest wait until they scroll. */
                loading={index === 0 ? 'eager' : 'lazy'}
                className="aspect-square w-full rounded-card border border-border bg-surface object-contain"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">{product.description}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {product.departmentName ?? 'Uncategorised'} · {product.code}
            </p>
          </div>
          {!product.inStock && <Badge tone="neutral">Out of stock</Badge>}
        </div>

        <p className="numeric mt-4 text-2xl font-semibold text-ink">
          {formatMoney(product.priceIncl)}
        </p>

        {reviews.count > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
            <Icons.Star size={15} className="fill-warning text-warning" aria-hidden />
            {reviews.average} out of 5 · {reviews.count}{' '}
            {reviews.count === 1 ? 'review' : 'reviews'}
          </p>
        )}

        <div className="mt-5">
          <AddToBasket product={product} token={token} />
        </div>
      </div>

      {reviews.reviews.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">What customers say</h2>
          <ul className="flex flex-col gap-3">
            {reviews.reviews.map((review) => (
              <li
                key={review.id}
                className="rounded-card border border-border bg-surface p-4 shadow-card"
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-0.5" aria-label={`${review.rating} of 5`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Icons.Star
                        key={n}
                        size={13}
                        className={n <= review.rating ? 'fill-warning text-warning' : 'text-faint'}
                        aria-hidden
                      />
                    ))}
                  </span>
                  {review.title && (
                    <span className="text-sm font-medium text-ink">{review.title}</span>
                  )}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-2">{review.body}</p>
                <p className="mt-1.5 text-xs text-muted">{review.authorName || 'Anonymous'}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

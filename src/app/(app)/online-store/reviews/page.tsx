import { requireSiteId } from '@/lib/auth'
import { listReviews, reviewCounts, type ReviewStatus } from '@/lib/site/productReviews'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import ReviewQueue from './ReviewQueue'

/**
 * Review moderation.
 *
 * Nothing a shopper writes appears on the storefront until it is approved
 * here — see 035_product_reviews.sql for why there is no way to switch that
 * off.
 */

export const dynamic = 'force-dynamic'

const STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected']

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams
  const status = STATUSES.includes(params.status as ReviewStatus)
    ? (params.status as ReviewStatus)
    : 'pending'

  const [reviews, counts] = await Promise.all([listReviews(siteId, status), reviewCounts(siteId)])

  return (
    <>
      <PageHeader
        title="Reviews"
        subtitle="What customers say about your products"
        action={
          counts.pending > 0 ? (
            <Badge tone="warning">{counts.pending} waiting</Badge>
          ) : undefined
        }
      />
      <PageBody>
        <ReviewQueue reviews={reviews} counts={counts} status={status} />
      </PageBody>
    </>
  )
}

import { requireModuleCapability } from '@/lib/auth'
import { listReviews, reviewCounts, type ReviewStatus } from '@/lib/site/productReviews'
import { PageHeader, PageBody, Badge, StatStrip, StatTile } from '@/components/ui'
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
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.view')
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
        <StatStrip columns={3}>
          {/* Waiting is the only tile that means "act on me"; the other two
              are plain counts. */}
          <StatTile
            label="Waiting"
            value={counts.pending.toLocaleString('en-ZA')}
            tone={counts.pending > 0 ? 'warning' : 'default'}
            hint="Need a decision before anyone sees them"
          />
          <StatTile
            label="Published"
            value={counts.approved.toLocaleString('en-ZA')}
            hint="Showing on your product pages"
          />
          <StatTile
            label="Rejected"
            value={counts.rejected.toLocaleString('en-ZA')}
            hint="Turned down, kept on record"
          />
        </StatStrip>
        <ReviewQueue reviews={reviews} counts={counts} status={status} />
      </PageBody>
    </>
  )
}

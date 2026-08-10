import { requireCapability } from '@/lib/auth'
import { funnel, productFunnel } from '@/lib/site/storefrontEvents'
import { PageBody, PageHeader } from '@/components/ui'
import FunnelView from './FunnelView'

/**
 * Where shoppers drop out.
 *
 * The report that makes the rest of the section answerable: variants, holds,
 * discount codes and basket reminders all cost something, and until now a shop
 * had no way to tell whether any of them sold anything.
 */

export const dynamic = 'force-dynamic'

export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const { siteId } = await requireCapability('online.view')
  const { days } = await searchParams

  /*
   * 30 days by default, clamped.
   *
   * A funnel over a week is mostly noise for a shop taking a handful of orders
   * a day, and a query over five years is a table scan nobody asked for.
   */
  const window = Math.min(Math.max(Number(days) || 30, 1), 365)

  /*
   * The window travels as a NUMBER OF DAYS, not as two timestamps.
   *
   * `created_at` is written by the database's clock; comparing it against this
   * process's clock silently drops everything when the two timezones differ.
   * Letting the database compute its own boundary makes that impossible.
   */
  const [report, products] = await Promise.all([
    funnel(siteId, window),
    productFunnel(siteId, window, 10),
  ])

  return (
    <>
      <PageHeader
        title="Shopper funnel"
        subtitle="How many people who looked went on to order."
      />
      <PageBody>
        <FunnelView report={report} products={products} days={window} />
      </PageBody>
    </>
  )
}

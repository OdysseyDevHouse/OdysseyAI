import { requireCapability } from '@/lib/auth'
import { listSchedules } from '@/lib/site/priceSchedules'
import { PageHeader, PageBody } from '@/components/ui'
import ScheduleList from './ScheduleList'

/**
 * Price changes waiting to happen, and the ones that already did.
 *
 * Applied and cancelled changes stay on this list. An applied one holds the
 * only record of what the prices used to be — it is what "put these back"
 * restores from — and a shop that raised prices in April will want to look at
 * what it did before doing it again in October.
 */

export const dynamic = 'force-dynamic'

export default async function PricingSchedulesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.edit')

  const schedules = await listSchedules(siteId)

  return (
    <>
      <PageHeader
        title="Price changes"
        subtitle="New prices that take effect on their own, at a date and time you choose"
      />
      <PageBody>
        <ScheduleList schedules={schedules} />
      </PageBody>
    </>
  )
}

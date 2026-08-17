import { requireModuleCapability } from '@/lib/auth'
import { listReasons } from '@/lib/site/stockAdjustments'
import { PageHeader, PageBody } from '@/components/ui'
import ReasonsClient from './ReasonsClient'

export const dynamic = 'force-dynamic'

export default async function AdjustmentReasonsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'setup.edit')
  // Retired reasons are shown here and nowhere else: this is the screen that
  // brings one back, so hiding them would make that impossible.
  const reasons = await listReasons(siteId, true)

  return (
    <>
      <PageHeader
        title="Adjustment reasons"
        subtitle="Why stock was written on or off. These are what a loss report groups by."
      />
      <PageBody>
        <ReasonsClient reasons={reasons} />
      </PageBody>
    </>
  )
}

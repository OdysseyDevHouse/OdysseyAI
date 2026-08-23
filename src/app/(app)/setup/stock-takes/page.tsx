import { requireCapability } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import StockTakeSettingsClient from './StockTakeSettingsClient'

export const dynamic = 'force-dynamic'

/**
 * The line between a variance somebody corrects and one somebody explains.
 *
 * Separate from Setup → Adjustment reasons, which is the other half of the same
 * sentence: that screen is the VOCABULARY a variance is explained in, this one
 * is when an explanation becomes compulsory. They are read by the same person
 * on the same day, which is why they sit beside each other on the hub.
 *
 * Guarded on setup.edit rather than stock.adjust deliberately — see actions.ts.
 * Somebody who can move the line can step over it.
 */
export default async function StockTakeSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [varianceQtyPct, varianceValue] = await Promise.all([
    getSetting(siteId, 'stock_take_variance_qty_pct'),
    getSetting(siteId, 'stock_take_variance_value'),
  ])

  return (
    <>
      <PageHeader
        title="Stock takes"
        subtitle="How large a counted difference may be before somebody other than the counter has to explain it."
      />
      <PageBody>
        <StockTakeSettingsClient settings={{ varianceQtyPct, varianceValue }} />
      </PageBody>
    </>
  )
}

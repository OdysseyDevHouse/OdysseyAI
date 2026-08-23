import { requireCapability } from '@/lib/auth'
import { has } from '@/lib/control/modules'
import { listReasons } from '@/lib/site/stockAdjustments'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { PageHeader, PageBody } from '@/components/ui'
import ReasonsClient from './ReasonsClient'

export const dynamic = 'force-dynamic'

export default async function ReasonsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, modules } = await requireCapability('setup.edit')

  /* The CAPABILITY is the same for all three lists, but the MODULE is not:
     voids and returns are part of every shop, adjustments belong to inventory.
     So the page itself is not module-gated — gating it would take the void and
     return lists away from a shop that is entitled to them — and the stock list
     is fetched, and its tab shown, only where the module is actually held. */
  const showAdjustments = has(modules, 'inventory_advanced')

  // Retired reasons are shown here and nowhere else: this is the screen that
  // brings one back, so hiding them would make that impossible.
  const [adjustmentReasons, voidReasons, returnReasons] = await Promise.all([
    showAdjustments ? listReasons(siteId, true) : Promise.resolve([]),
    listSalesReasons(siteId, 'void', true),
    listSalesReasons(siteId, 'return', true),
  ])

  return (
    <>
      <PageHeader
        title="Reasons"
        subtitle="Why stock was written on or off, why a sale was cancelled, and why goods came back. These are what the loss and exception reports group by."
      />
      <PageBody>
        <ReasonsClient
          adjustmentReasons={adjustmentReasons}
          voidReasons={voidReasons}
          returnReasons={returnReasons}
          showAdjustments={showAdjustments}
        />
      </PageBody>
    </>
  )
}

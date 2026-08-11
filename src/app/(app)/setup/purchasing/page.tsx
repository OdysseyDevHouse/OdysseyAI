import { requireCapability } from '@/lib/auth'
import { getSetting } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import PurchasingSettingsClient from './PurchasingSettingsClient'

export const dynamic = 'force-dynamic'

/**
 * Buying and costing stock.
 *
 * Separate from Setup → Price types & VAT, which is the other half of the same
 * sentence: that screen is what a product SELLS for, this one is what it is
 * held at. They are read by different people on different days — a manager sets
 * up a wholesale tier once, where the cost basis is a decision the owner makes
 * at go-live and revisits when the accountant asks.
 */
export default async function PurchasingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [costBasis, invoiceTolerance, costWarnPct] = await Promise.all([
    getSetting(siteId, 'cost_basis'),
    getSetting(siteId, 'purchase_invoice_tolerance'),
    getSetting(siteId, 'purchase_cost_change_warn_pct'),
  ])

  return (
    <>
      <PageHeader
        title="Purchasing & cost"
        subtitle="How stock is costed, and the checks that run when a delivery is posted."
      />
      <PageBody>
        <PurchasingSettingsClient
          settings={{
            // Same defaulting the action uses: anything unrecognised reads as
            // 'average', which is the default every untouched site is on.
            costBasis: costBasis === 'last' ? 'last' : 'average',
            invoiceTolerance,
            costWarnPct,
          }}
        />
      </PageBody>
    </>
  )
}

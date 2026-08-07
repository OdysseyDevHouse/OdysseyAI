import { requireCapability } from '@/lib/auth'
import {
  listVatRatesForSetup,
  listPriceStructuresForSetup,
} from '@/lib/site/pricingSetup'
import { listDepartments } from '@/lib/site/departments'
import { listBrands } from '@/lib/site/lookups'
import { getSetting } from '@/lib/site/settings'
import { toEndingDirection } from '@/lib/repricing'
import { PageHeader, PageBody } from '@/components/ui'
import PricingClient from './PricingClient'

export const dynamic = 'force-dynamic'

/**
 * Price types and VAT on one screen.
 *
 * They are two tables but one job: what a line costs. Splitting them into two
 * menu entries would mean setting up a wholesale tier in one place and the rate
 * it charges in another.
 */
export default async function PricingSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  // Departments and brands are here only to scope a bulk reprice.
  const [vatRates, structures, departments, brands, endingDirection] = await Promise.all([
    listVatRatesForSetup(siteId),
    listPriceStructuresForSetup(siteId),
    listDepartments(siteId),
    listBrands(siteId),
    getSetting(siteId, 'price_ending_direction'),
  ])

  return (
    <>
      <PageHeader
        title="Price types & VAT"
        subtitle="The price tiers a product can carry, and the tax rates applied to them."
      />
      <PageBody>
        <PricingClient
          vatRates={vatRates}
          structures={structures}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          defaultEndingDirection={toEndingDirection(endingDirection)}
        />
      </PageBody>
    </>
  )
}

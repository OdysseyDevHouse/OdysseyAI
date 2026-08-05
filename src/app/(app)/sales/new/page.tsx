import { requireSite } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listParked } from '@/lib/site/salesDocuments'
import { listPriceStructures } from '@/lib/site/lookups'
import { getNumericSetting } from '@/lib/site/settings'
import { capabilitiesFor, can } from '@/lib/site/permissions'
import { PageHeader } from '@/components/ui'
import TillScreen from './TillScreen'

export const dynamic = 'force-dynamic'

export default async function NewSalePage() {
  const site = await requireSite()

  const [terminals, tenders, parked, structures, cashRounding, capabilities] = await Promise.all([
    listTerminals(site.id, false),
    listTenderTypes(site.id),
    listParked(site.id),
    listPriceStructures(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
    capabilitiesFor(site.id, site.role),
  ])

  // The default structure is the shelf price; fall back to the first if none is
  // flagged, which is what listProducts already assumes.
  const priceStructure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="New sale" subtitle={site.displayName} />
      <TillScreen
        terminals={terminals}
        tenders={tenders}
        priceStructureId={priceStructure?.id ?? null}
        parkedCount={parked.length}
        cashRounding={cashRounding}
        canOverrideDiscount={can(capabilities, 'sales.discount_override')}
      />
    </div>
  )
}

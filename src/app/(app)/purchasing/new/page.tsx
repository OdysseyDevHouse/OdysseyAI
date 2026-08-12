import { requireCapability } from '@/lib/auth'
import { listSuppliers } from '@/lib/site/suppliers'
import { listVatRates, defaultVat } from '@/lib/site/lookups'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import OrderScreen from '../OrderScreen'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.edit')

  const [suppliers, vatRates, locations] = await Promise.all([
    listSuppliers(siteId, { statuses: ['active'], limit: 200 }),
    listVatRates(siteId),
    // Active only: there is no sense in ordering goods towards a location that
    // has been closed, even though one may still hold stock from before.
    listLocations(siteId, false, true),
  ])

  // Purchase VAT on the way in, sales VAT for the margin columns — a product
  // can carry a different rate in each direction.
  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')
  const salesVat = defaultVat(vatRates, 'sales') ?? purchaseVat

  return (
    <>
      <PageHeader
        title="New purchase order"
        subtitle="What to ask for, and from whom. Nothing moves until it arrives."
        backHref="/purchasing"
        backLabel="Purchasing"
      />
      <OrderScreen
        suppliers={suppliers.items.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          terms: s.paymentTermsDays,
          leadTimeDays: s.leadTimeDays,
          minimumOrder: s.minimumOrder,
        }))}
        defaultVatRate={purchaseVat?.rate ?? 0}
        sellingVatRate={salesVat?.rate ?? 0}
        locations={locations.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          isMain: l.isMain,
        }))}
      />
    </>
  )
}

import { requireCapability } from '@/lib/auth'
import { listSuppliers } from '@/lib/site/suppliers'
import { openOrders } from '@/lib/site/purchaseDocuments'
import { listVatRates, defaultVat } from '@/lib/site/lookups'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import ReceiveScreen from './ReceiveScreen'

export const dynamic = 'force-dynamic'

export default async function ReceivePage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.edit')

  const [suppliers, orders, vatRates, locations] = await Promise.all([
    listSuppliers(siteId, { statuses: ['active'], limit: 200 }),
    openOrders(siteId),
    listVatRates(siteId),
    // Active only: goods cannot be received into a location that has been
    // closed, even though one may still hold stock from before.
    listLocations(siteId, false),
  ])

  // Purchase VAT, not sales VAT — a product can carry a different rate on the
  // way in from the one it carries on the way out.
  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')
  // And the way out, for the margin columns: markup and GP compare a cost to a
  // SELLING price, and taking the purchase rate off a shelf price would
  // misstate both wherever the two rates differ.
  const salesVat = defaultVat(vatRates, 'sales') ?? purchaseVat

  return (
    <>
      <PageHeader
        title="Receive goods"
        subtitle="Stock in, costs updated, supplier credited."
        backHref="/purchasing"
        backLabel="Purchasing"
      />
      <ReceiveScreen
        suppliers={suppliers.items.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          terms: s.paymentTermsDays,
        }))}
        openOrders={orders.map((o) => ({
          id: o.id,
          documentNumber: o.documentNumber,
          supplierId: o.supplierId,
          supplierName: o.supplierName,
          documentDate: o.documentDate,
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

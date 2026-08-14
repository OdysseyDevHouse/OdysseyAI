import { notFound, redirect } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getPurchaseDocument, productPositions } from '@/lib/site/purchaseDocuments'
import { listSuppliers } from '@/lib/site/suppliers'
import { listVatRates, defaultVat } from '@/lib/site/lookups'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import OrderScreen from '../../OrderScreen'

export const dynamic = 'force-dynamic'

export default async function EditOrderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.edit')
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc) notFound()

  // Only a DRAFT order is editable, and the redirect says so by landing on the
  // document itself rather than showing a form that cannot save. saveOrder()
  // refuses the same cases — this is the polite version of that refusal.
  //
  // An ISSUED order is deliberately included: it has been sent to the supplier
  // and carries a number, and quietly rewriting what they were asked for would
  // make our copy disagree with theirs. Cancel it and raise another.
  if (doc.docType !== 'purchase_order' || doc.status !== 'draft') {
    redirect(`/purchasing/${documentId}`)
  }

  const [suppliers, vatRates, locations, positions] = await Promise.all([
    listSuppliers(siteId, { statuses: ['active'], limit: 200 }),
    listVatRates(siteId),
    // Active only: there is no sense in ordering goods towards a location that
    // has been closed, even though one may still hold stock from before.
    listLocations(siteId, false, true),
    // Where these products stand NOW. The order snapshotted its costs when it
    // was raised, so without this every margin column would price against a
    // stale figure and the stock column would read zero.
    productPositions(
      siteId,
      doc.lines.map((l) => l.productId).filter((pid): pid is number => pid !== null),
    ),
  ])

  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')
  const salesVat = defaultVat(vatRates, 'sales') ?? purchaseVat
  const positionFor = new Map(positions.map((p) => [p.productId, p]))

  return (
    <>
      <PageHeader
        title={`Edit draft #${doc.id}`}
        subtitle={`${doc.supplierName} · nothing has been received`}
        /* The LIST, not the document. Clicking a draft in the list now lands
           here directly, so the document is a screen this user has never seen —
           sending them "back" to it would be somewhere they have not been.
           Receiving's back link goes to the same place, for the same reason. */
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
        existing={{
          id: doc.id,
          supplierId: doc.supplierId,
          documentDate: doc.documentDate,
          expectedDate: doc.expectedDate,
          supplierOrderNo: doc.supplierOrderNo,
          reference: doc.reference,
          notes: doc.notes,
          lines: doc.lines.map((l, index) => ({
            key: `line-${l.id}-${index}`,
            productId: l.productId,
            productCode: l.productCode,
            supplierCode: l.supplierCode ?? '',
            description: l.description,
            productType: l.productType,
            qtyOrdered: l.qtyOrdered,
            qty: l.qtyOrdered,
            qtyBonus: 0,
            unitCostExcl: l.unitCostExcl,
            discountPct: l.discountPct,
            discountAmount: l.discountAmount,
            vatRatePct: l.vatRatePct,
            // Whatever the buyer asked for. Null on an order raised before the
            // column existed, and null again if that location has since been
            // closed — either way the grid reads "— At receipt —" rather than
            // showing a dropdown whose value has no option behind it.
            locationId: locations.some((loc) => loc.id === l.locationId) ? l.locationId : null,
            currentAverage: positionFor.get(l.productId ?? -1)?.averageCost ?? 0,
            lastCost: positionFor.get(l.productId ?? -1)?.lastCost ?? 0,
            currentStock: positionFor.get(l.productId ?? -1)?.stockOnHand ?? 0,
            sellIncl: positionFor.get(l.productId ?? -1)?.sellIncl ?? 0,
            // Carried into the form so it survives the save (163). saveOrder
            // deletes and re-inserts every line, so a job link that does not
            // make this round trip is lost the first time somebody edits the
            // order — silently, because the parts still arrive.
            jobCardLineId: l.jobCardLineId,
          })),
        }}
      />
    </>
  )
}

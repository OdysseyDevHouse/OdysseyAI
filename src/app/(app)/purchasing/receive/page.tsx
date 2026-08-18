import { requireCapability } from '@/lib/auth'
import { listSuppliers } from '@/lib/site/suppliers'
import {
  openOrders,
  getPurchaseDocument,
  documentCharges,
  productPositions,
} from '@/lib/site/purchaseDocuments'
import { listVatRates, defaultVat } from '@/lib/site/lookups'
import { listLocations } from '@/lib/site/stockLocations'
import { getNumericSetting } from '@/lib/site/settings'
import { isScanConfigured } from '@/lib/import/documentScan'
import ReceiveScreen from './ReceiveScreen'

export const dynamic = 'force-dynamic'

export default async function ReceivePage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; draft?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.edit')
  const params = await searchParams

  // A draft being reopened. Loaded before anything else so the rest of the
  // screen can be seeded from it, and refused if it is not actually a draft —
  // the id comes from a URL, and a finalised receipt must not open in an
  // editor that would let it be posted twice.
  const draftId = Number(params.draft)
  const draftDoc =
    Number.isFinite(draftId) && draftId > 0 ? await getPurchaseDocument(siteId, draftId) : null
  const draft =
    draftDoc && draftDoc.docType === 'grv' && draftDoc.status === 'draft' ? draftDoc : null
  const draftCharges = draft ? await documentCharges(siteId, draft.id) : []
  const draftPositions = draft
    ? await productPositions(
        siteId,
        draft.lines.map((l) => l.productId).filter((id): id is number => id !== null),
      )
    : []

  const [suppliers, orders, vatRates, locations] = await Promise.all([
    listSuppliers(siteId, { statuses: ['active'], limit: 200 }),
    openOrders(siteId),
    listVatRates(siteId),
    // Active only: goods cannot be received into a location that has been
    // closed, even though one may still hold stock from before.
    listLocations(siteId, false, true),
  ])

  // Purchase VAT, not sales VAT — a product can carry a different rate on the
  // way in from the one it carries on the way out.
  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')
  // And the way out, for the margin columns: markup and GP compare a cost to a
  // SELLING price, and taking the purchase rate off a shelf price would
  // misstate both wherever the two rates differ.
  const salesVat = defaultVat(vatRates, 'sales') ?? purchaseVat
  // Read here rather than in the client: a threshold the browser could set is
  // not a control. Zero switches the warning off entirely.
  const costWarnPct = await getNumericSetting(siteId, 'purchase_cost_change_warn_pct')

  return (
    <>
      {/* The header is rendered by ReceiveScreen, not here: its two actions —
          "Receive the goods" and the draft save — carry the client's pending
          and validation state, which a server component cannot hand them. */}
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
        costWarnPct={costWarnPct}
        // Arrives from "Receive" on an issued order. Validated against the
        // open list rather than trusted: the id comes from a URL, and one that
        // names a closed or foreign order must simply be ignored.
        initialOrderId={
          orders.some((o) => o.id === Number(params.order)) ? Number(params.order) : null
        }
        draft={
          draft
            ? {
                id: draft.id,
                supplierId: draft.supplierId,
                supplierInvoiceNo: draft.supplierInvoiceNo ?? '',
                orderId: draft.orderedFromId,
                reference: draft.reference ?? '',
                notes: draft.notes ?? '',
                discountPct: draft.discountPct,
                discountExcl: draft.discountExcl,
                lines: draft.lines.map((l, index) => {
                  const pos = draftPositions.find((p) => p.productId === l.productId)
                  return {
                    key: `draft-${l.id}-${index}`,
                    orderLineId: null,
                    productId: l.productId,
                    productCode: l.productCode,
                    supplierCode: l.supplierCode ?? '',
                    description: l.description,
                    productType: l.productType,
                    departmentId: l.departmentId,
                    qtyOrdered: l.qtyOrdered,
                    qty: l.qtyReceived,
                    qtyBonus: l.qtyBonus,
                    unitCostExcl: l.unitCostExcl,
                    discountPct: l.discountPct,
                    discountAmount: l.discountAmount,
                    vatRatePct: l.vatRatePct,
                    locationId: l.locationId,
                    serials: [],
                    warrantyUntil: '',
                    // Lot data is client state only, like serials: a draft
                    // that sat overnight asks for the note again at posting.
                    batchNo: '',
                    expiryDate: '',
                    // Read fresh rather than from the draft: it may have sat
                    // overnight, and the cost preview must reflect where the
                    // product stands NOW, not when it was put down.
                    currentAverage: pos?.averageCost ?? 0,
                    lastCost: pos?.lastCost ?? 0,
                    currentStock: pos?.stockOnHand ?? 0,
                    sellIncl: pos?.sellIncl ?? 0,
                  }
                }),
                charges: draftCharges.map((c) => ({
                  key: `charge-${c.id}`,
                  supplierId: c.supplierId,
                  description: c.description,
                  amountExcl: c.amountExcl,
                  vatRatePct: c.vatRatePct,
                  theirInvoiceNo: c.theirInvoiceNo ?? '',
                })),
              }
            : null
        }
        locations={locations.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          isMain: l.isMain,
        }))}
        scanConfigured={isScanConfigured()}
      />
    </>
  )
}

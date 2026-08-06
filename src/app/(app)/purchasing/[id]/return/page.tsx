import { notFound, redirect } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getPurchaseDocument } from '@/lib/site/purchaseDocuments'
import { returnableLines } from '@/lib/site/purchaseReversal'
import { PageHeader } from '@/components/ui'
import ReturnScreen from './ReturnScreen'

export const dynamic = 'force-dynamic'

export default async function SupplierReturnPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const siteId = await requireSiteId()
  const { id } = await params

  const grvId = Number(id)
  if (!Number.isFinite(grvId) || grvId <= 0) notFound()

  const doc = await getPurchaseDocument(siteId, grvId)
  if (!doc) notFound()

  // Only a finalised GRV can be returned against. Sending someone to a screen
  // that can only refuse them is worse than not offering it, so this bounces
  // back to the document rather than rendering a dead form.
  if (doc.docType !== 'grv' || doc.status !== 'finalised') redirect(`/purchasing/${grvId}`)

  const lines = await returnableLines(siteId, grvId)
  if (!lines) notFound()

  return (
    <>
      <PageHeader
        title={`Return against ${doc.documentNumber}`}
        subtitle={`${doc.supplierName} · received ${doc.documentDate}`}
        backHref={`/purchasing/${grvId}`}
        backLabel={doc.documentNumber ?? 'Receipt'}
      />
      <ReturnScreen
        grvId={grvId}
        grvNumber={doc.documentNumber ?? ''}
        supplierName={doc.supplierName ?? ''}
        lines={lines.map((l) => ({
          id: l.id,
          productId: l.productId,
          productCode: l.productCode,
          supplierCode: l.supplierCode,
          description: l.description,
          productType: l.productType,
          departmentId: l.departmentId,
          qtyReceived: l.qtyReceived,
          alreadyReturned: l.alreadyReturned,
          returnable: l.returnable,
          // The LANDED cost, not the invoice cost: what it actually cost to
          // get the goods here is what going back is worth.
          unitCostExcl: l.landedCostExcl || l.unitCostExcl,
          vatRatePct: l.vatRatePct,
          locationId: l.locationId,
        }))}
      />
    </>
  )
}

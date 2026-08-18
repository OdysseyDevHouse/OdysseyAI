import { notFound } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { loadSaleRecord } from '@/lib/site/saleRecord'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import { STATUS_LABELS, STATUS_TONE } from '../status'
import DocumentActionBar from './DocumentActionBar'
import { SaleRecord } from './SaleRecord'
import type { SalesDocStatus } from '@/lib/site/salesDocuments'

export const dynamic = 'force-dynamic'

export default async function SalesDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  /* Capabilities are no longer read here: every "may they" for the action bar
     is resolved inside DocumentActionBar, which is the one place that decides. */
  const { site } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  /* The body of this page is <SaleRecord>, fed by one loader — the same pair the
     invoicing screen shows in its dialog the moment an invoice posts. See
     loadSaleRecord() for why that is worth the indirection. */
  const sale = await loadSaleRecord(site.id, documentId)
  if (!sale) notFound()

  const status = sale.status as SalesDocStatus

  return (
    <>
      <PageHeader
        title={sale.documentNumber ?? `Draft #${sale.id}`}
        subtitle={`${sale.docLabel} · ${sale.documentDate}`}
        backHref="/invoicing?status=all"
        backLabel="Invoicing"
        action={
          <>
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
            <DocumentActionBar documentId={sale.id} />
          </>
        }
      />

      <PageBody>
        <SaleRecord sale={sale} />
      </PageBody>
    </>
  )
}

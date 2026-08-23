import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
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
  /* `sales.view` — the SAME right the register at /invoicing asks for, because
     this is one of its rows opened up. It used to be `requireSiteUser`, which
     proves somebody is signed in and nothing else, so any user with any role
     could read any sale by typing its id: every line, the cost and margin on
     each, and the customer it was rung up for.

     The comment that stood here said capabilities were resolved in
     DocumentActionBar instead. That is true of the BUTTONS and only of them —
     void, credit, reprint. The record below them rendered for anyone, so the
     one thing worth protecting was the one thing left unguarded.

     Which of those buttons a person gets is still DocumentActionBar's call. */
  const { siteId } = await requireCapability('sales.view')
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  /* The body of this page is <SaleRecord>, fed by one loader — the same pair the
     invoicing screen shows in its dialog the moment an invoice posts. See
     loadSaleRecord() for why that is worth the indirection. */
  const sale = await loadSaleRecord(siteId, documentId)
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

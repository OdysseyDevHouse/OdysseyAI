import { requireCapability } from '@/lib/auth'
import { listDocuments } from '@/lib/site/salesDocuments'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import { PageHeader, PageBody, Card, SearchBar, Pagination, Icons } from '@/components/ui'
import NewInvoiceButton from './NewInvoiceButton'
import InvoicingTable, { type InvoiceTableRow } from './InvoicingTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * Invoices still being captured.
 *
 * Deliberately not the same list as /sales: that is the record of everything
 * ever issued, whereas this is a worklist — the invoices someone still has to
 * finish. A finalised invoice leaves this screen, which is the point of it.
 */
export default async function InvoicingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.edit')
  const params = await searchParams
  const page = pageFrom(params.page)

  const { items, total } = await listDocuments(siteId, {
    docTypes: ['invoice'],
    statuses: ['draft', 'saved'],
    search: params.q,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  const href = hrefBuilder('/sales/invoicing', params)

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the table lives in InvoicingTable and gets plain rows.
  const rows: InvoiceTableRow[] = items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    documentDate: doc.documentDate,
    customerName: doc.customerName,
    reference: doc.reference,
    totalIncl: doc.totalIncl,
    status: doc.status === 'saved' ? 'saved' : 'draft',
  }))

  return (
    <>
      <PageHeader
        title="Invoicing"
        subtitle={`${total} in progress`}
        action={<NewInvoiceButton />}
      />

      <PageBody>
        <SearchBar
          action="/sales/invoicing"
          defaultValue={params.q}
          placeholder="Search by number, customer or order number…"
          className="p-0"
        />

        <Card>
          <InvoicingTable
            rows={rows}
            empty={{
              icon: <Icons.FileText size={22} />,
              title: params.q ? `Nothing matches “${params.q}”` : 'No invoices in progress',
              hint: params.q
                ? 'Try a different number, customer or order number.'
                : 'Start one to capture an invoice off an order form. Finalised invoices move to Documents.',
              action: params.q ? undefined : <NewInvoiceButton />,
            }}
          />

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </PageBody>
    </>
  )
}

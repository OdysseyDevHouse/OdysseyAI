import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { listDocuments } from '@/lib/site/salesDocuments'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  Card,
  SearchBar,
  Pagination,
  EmptyState,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import NewInvoiceButton from './NewInvoiceButton'

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
  const siteId = await requireSiteId()
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

  return (
    <>
      <PageHeader
        title="Invoicing"
        subtitle={`${total} in progress`}
        action={<NewInvoiceButton />}
      />

      <SearchBar
        action="/sales/invoicing"
        defaultValue={params.q}
        placeholder="Search by number, customer or order number…"
      />

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              icon={<Icons.FileText size={22} />}
              title={params.q ? `Nothing matches “${params.q}”` : 'No invoices in progress'}
              hint={
                params.q
                  ? 'Try a different number, customer or order number.'
                  : 'Start one to capture an invoice off an order form. Finalised invoices move to Documents.'
              }
              action={params.q ? undefined : <NewInvoiceButton />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Number</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Customer</th>
                    <th className={TABLE_TH}>Order number</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((doc) => (
                    <tr key={doc.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/sales/invoicing/${doc.id}`}
                          className="text-brand hover:underline"
                        >
                          {doc.documentNumber ?? `Invoice #${doc.id}`}
                        </Link>
                      </td>
                      <td className={TABLE_TD}>{doc.documentDate}</td>
                      <td className={TABLE_TD}>{doc.customerName ?? 'Walk-in'}</td>
                      <td className={TABLE_TD}>{doc.reference ?? '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(doc.totalIncl)}
                      </td>
                      <td className={TABLE_TD}>
                        <Badge tone={doc.status === 'saved' ? 'warning' : 'neutral'}>
                          {doc.status === 'saved' ? 'Saved' : 'Draft'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </div>
    </>
  )
}

import { requireCapability } from '@/lib/auth'
import { listDocuments, toDocStatus, DOC_LABELS, type SalesDocStatus } from '@/lib/site/salesDocuments'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  StatStrip,
  StatTile,
  FilterChip,
  LinkSegmentedControl,
  TableToolbar,
  Pagination,
  Icons,
} from '@/components/ui'
import { STATUS_LABELS } from './status'
import SalesTable, { type SalesDocTableRow } from './SalesTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; from?: string; to?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams

  const status = toDocStatus(params.status)
  const page = pageFrom(params.page)

  const { items, total } = await listDocuments(siteId, {
    docTypes: ['invoice', 'credit_sale'],
    statuses: status ? [status] : undefined,
    search: params.q,
    from: params.from,
    to: params.to,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  // Today's takings, which is the figure a manager opens this screen for.
  const today = new Date().toISOString().slice(0, 10)
  const [{ items: todayDocs }, { total: savedTotal }] = await Promise.all([
    listDocuments(siteId, {
      docTypes: ['invoice', 'credit_sale'],
      statuses: ['finalised'],
      from: today,
      to: today,
      limit: 500,
    }),
    // The SITE-WIDE saved count, not the count on this page — a stat strip
    // must never mix denominators, and the page slice is not a denominator.
    listDocuments(siteId, {
      docTypes: ['invoice', 'credit_sale'],
      statuses: ['saved'],
      limit: 1,
    }),
  ])
  const takings = todayDocs.reduce((sum, d) => sum + d.totalIncl, 0)

  const href = hrefBuilder('/sales', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  const filtered = Boolean(params.q || status || params.from || params.to)

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the table lives in SalesTable and gets plain rows.
  const rows: SalesDocTableRow[] = items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    docTypeLabel: doc.docType !== 'invoice' ? DOC_LABELS[doc.docType] : null,
    documentDate: doc.documentDate,
    customerName: doc.customerName,
    terminalCode: doc.terminalCode,
    userName: doc.userName,
    totalIncl: doc.totalIncl,
    status: doc.status,
    cancelReason: doc.cancelReason,
  }))

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle={`${total} document${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/sales/new">
            <Icons.Plus size={15} />
            New sale
          </PrimaryLink>
        }
      />

      <PageBody>
        <StatStrip columns={3}>
          <StatTile
            label="Today's takings"
            value={formatMoney(takings)}
            hint={`${todayDocs.length} sale${todayDocs.length === 1 ? '' : 's'}`}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Documents"
            value={String(total)}
            hint="Matching the current filter"
            icon={<Icons.Receipt size={16} />}
          />
          <StatTile
            label="Saved"
            value={String(savedTotal)}
            hint="Waiting to be recalled"
            tone={savedTotal > 0 ? 'warning' : 'default'}
            icon={<Icons.Clock size={16} />}
            href={filterHref({ status: 'saved' })}
          />
        </StatStrip>

        {/* Status is not a chip here — the segmented control already shows
            which slice is active and how to leave it. The date filters get
            chips: they have no other visible affordance to clear them. */}
        <TableToolbar
          actions={
            <div className="w-80">
              <SearchBar
                action="/sales"
                defaultValue={params.q}
                placeholder="Search number, customer or reference…"
                className="p-0"
                keep={{ status: params.status, from: params.from, to: params.to }}
              />
            </div>
          }
        >
          <LinkSegmentedControl
            aria-label="Filter by status"
            value={status ?? 'all'}
            options={[
              { value: 'all', label: 'All', href: filterHref({ status: null }) },
              ...(['finalised', 'saved', 'cancelled'] as SalesDocStatus[]).map((value) => ({
                value,
                label: STATUS_LABELS[value],
                href: filterHref({ status: value }),
              })),
            ]}
          />
          {params.from && (
            <FilterChip label="From" value={params.from} clearHref={filterHref({ from: null })} />
          )}
          {params.to && (
            <FilterChip label="To" value={params.to} clearHref={filterHref({ to: null })} />
          )}
        </TableToolbar>

        <Card>
          <SalesTable
            rows={rows}
            empty={
              params.q
                ? {
                    title: `Nothing matches “${params.q}”`,
                    hint: 'Check the number or customer name, or clear the search.',
                    icon: <Icons.Search size={22} />,
                    action: (
                      <ButtonLink variant="secondary" href={filterHref({ q: null })}>
                        Clear the search
                      </ButtonLink>
                    ),
                  }
                : filtered
                  ? {
                      title: 'Nothing in this slice',
                      hint: 'No documents match the current status or dates.',
                      icon: <Icons.Filter size={22} />,
                      action: (
                        <ButtonLink variant="secondary" href="/sales">
                          Clear the filters
                        </ButtonLink>
                      ),
                    }
                  : {
                      title: 'No sales yet',
                      hint: 'Ring one up from the till to see it here.',
                      icon: <Icons.Receipt size={22} />,
                      action: (
                        <ButtonLink variant="secondary" href="/sales/new">
                          <Icons.Banknote size={15} />
                          Open the till
                        </ButtonLink>
                      ),
                    }
            }
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

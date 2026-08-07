import { requireCapability } from '@/lib/auth'
import { listPurchaseDocuments, PURCHASE_DOC_LABELS } from '@/lib/site/purchaseDocuments'
import { supplierAgingSummary } from '@/lib/site/supplierLedger'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  SearchBar,
  StatStrip,
  StatTile,
  FilterBar,
  FilterChip,
  LinkSegmentedControl,
  Pagination,
  TableToolbar,
  Icons,
} from '@/components/ui'
import { purchaseStatusLabel } from './status'
import PurchasingTable, { type PurchasingRow } from './PurchasingTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; status?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.view')
  const params = await searchParams

  const type = (['purchase_order', 'grv', 'supplier_return'] as const).find(
    (t) => t === params.type,
  )
  const page = pageFrom(params.page)

  const [{ items, total }, aging, open] = await Promise.all([
    listPurchaseDocuments(siteId, {
      docTypes: type ? [type] : undefined,
      statuses: params.status ? [params.status] : undefined,
      search: params.q,
      limit: PAGE_SIZE,
      offset: offsetFor(page, PAGE_SIZE),
    }),
    supplierAgingSummary(siteId),
    listPurchaseDocuments(siteId, { docTypes: ['purchase_order'], statuses: ['issued'], limit: 200 }),
  ])

  const href = hrefBuilder('/purchasing', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })
  const onOrder = open.items.reduce((sum, d) => sum + d.totalIncl, 0)
  const overdue = aging.d30 + aging.d60 + aging.d90 + aging.d120
  const filtered = Boolean(params.q || type || params.status)

  // Only plain data crosses to the client table — functions cannot.
  const rows: PurchasingRow[] = items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    docLabel: doc.docLabel,
    documentDate: doc.documentDate,
    supplierName: doc.supplierName,
    supplierInvoiceNo: doc.supplierInvoiceNo,
    subtotalExcl: doc.subtotalExcl,
    totalIncl: doc.totalIncl,
    status: doc.status,
    fulfilmentStatus: doc.fulfilmentStatus,
    cancelReason: doc.cancelReason,
  }))

  return (
    <>
      <PageHeader
        title="Purchasing"
        subtitle={`${total} document${total === 1 ? '' : 's'}`}
        action={
          // Receiving IS how purchases enter the system — a GRV can be raised
          // with or without an order, so it is the one primary act here. (The
          // old "New order" link pointed at /purchasing/new, which never
          // existed as a screen.)
          <PrimaryLink href="/purchasing/receive">
            <Icons.PackageOpen size={15} />
            Receive goods
          </PrimaryLink>
        }
      />

      <PageBody>
        {/* Three tiles, not four: "Documents" restated the subtitle, and no
            fetched figure earns the fourth slot. */}
        <StatStrip columns={3}>
          <StatTile
            label="Owed to suppliers"
            value={formatMoney(aging.total)}
            hint="Across every open invoice"
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Overdue"
            value={formatMoney(overdue)}
            tone={overdue > 0 ? 'warning' : 'default'}
            hint="Past their terms"
            icon={<Icons.StatusWarning size={16} />}
            href="/suppliers/age-analysis"
          />
          <StatTile
            label="On order"
            value={formatMoney(onOrder)}
            hint={`${open.items.length} order${open.items.length === 1 ? '' : 's'} awaiting delivery`}
            icon={<Icons.Truck size={16} />}
            href={filterHref({ type: 'purchase_order', status: 'issued' })}
          />
        </StatStrip>

        {/* SearchBar and FilterBar carry the page gutter themselves; unwind
            PageBody's so the controls still line up with everything else. */}
        <div className="-mx-6 -my-3">
          <SearchBar
            action="/purchasing"
            defaultValue={params.q}
            placeholder="Search by number, supplier or their invoice number…"
            keep={{ type: params.type, status: params.status }}
          />
        </div>

        {/* Type is not a chip here — the segmented control below already shows
            which slice is active. Status stays: the "On order" tile is the only
            thing that sets it, and this chip is the only way to clear it. */}
        {params.status && (
          <div className="-mx-6 -mt-5">
            <FilterBar clearHref="/purchasing">
              <FilterChip
                label="Status"
                value={purchaseStatusLabel(params.status)}
                clearHref={filterHref({ status: null })}
              />
            </FilterBar>
          </div>
        )}

        <Card>
          <TableToolbar className="border-b border-border px-4 py-3.5">
            <LinkSegmentedControl
              aria-label="Filter by document type"
              value={type ?? 'all'}
              options={[
                { value: 'all', label: 'All', href: filterHref({ type: null }) },
                ...(['purchase_order', 'grv', 'supplier_return'] as const).map((value) => ({
                  value,
                  label: PURCHASE_DOC_LABELS[value],
                  href: filterHref({ type: value }),
                })),
              ]}
            />
          </TableToolbar>

          <PurchasingTable rows={rows} search={params.q} filtered={filtered} />

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

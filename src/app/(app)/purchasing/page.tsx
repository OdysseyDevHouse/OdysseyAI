import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { listPurchaseDocuments, PURCHASE_DOC_LABELS } from '@/lib/site/purchaseDocuments'
import { supplierAgingSummary } from '@/lib/site/supplierLedger'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PrimaryLink,
  Card,
  SearchBar,
  StatTile,
  FilterBar,
  FilterChip,
  LinkSegmentedControl,
  Pagination,
  EmptyState,
  Badge,
  Icons,
  ButtonLink,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  draft: 'neutral',
  issued: 'brand',
  finalised: 'success',
  void: 'danger',
  cancelled: 'neutral',
}

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; status?: string; page?: string }>
}) {
  const siteId = await requireSiteId()
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

  return (
    <>
      <PageHeader
        title="Purchasing"
        subtitle={`${total} document${total === 1 ? '' : 's'}`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href="/purchasing/receive" variant="secondary">
              <Icons.PackageOpen size={15} />
              Receive goods
            </ButtonLink>
            <PrimaryLink href="/purchasing/new">
              <Icons.Plus size={15} />
              New order
            </PrimaryLink>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Owed to suppliers"
          value={formatMoney(aging.total)}
          hint="Across every open invoice"
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Overdue"
          value={formatMoney(aging.d30 + aging.d60 + aging.d90 + aging.d120)}
          tone={aging.d30 + aging.d60 + aging.d90 + aging.d120 > 0 ? 'warning' : 'default'}
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
        <StatTile
          label="Documents"
          value={String(total)}
          hint="Matching the current filter"
          icon={<Icons.Receipt size={16} />}
        />
      </div>

      <SearchBar
        action="/purchasing"
        defaultValue={params.q}
        placeholder="Search by number, supplier or their invoice number…"
        keep={{ type: params.type, status: params.status }}
      />

      {/* Type is not a chip here — the segmented control below already shows
          which slice is active. Status stays: the "On order" tile is the only
          thing that sets it, and this chip is the only way to clear it. */}
      <FilterBar clearHref="/purchasing">
        {params.status && (
          <FilterChip label="Status" value={params.status} clearHref={filterHref({ status: null })} />
        )}
      </FilterBar>

      <div className="px-6 pb-3">
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
      </div>

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="Nothing purchased yet"
              hint="Raise an order, or receive goods straight in if they arrived without one."
              icon={<Icons.PackageOpen size={22} />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Number</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Supplier</th>
                    <th className={TABLE_TH}>Their invoice</th>
                    <th className={`${TABLE_TH} text-right`}>Excl. VAT</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((doc) => (
                    <tr key={doc.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link href={`/purchasing/${doc.id}`} className="text-brand hover:underline">
                          {doc.documentNumber ?? `Draft #${doc.id}`}
                        </Link>
                        <div className="text-xs text-muted">{doc.docLabel}</div>
                      </td>
                      <td className={TABLE_TD}>{doc.documentDate}</td>
                      <td className={TABLE_TD}>{doc.supplierName ?? '—'}</td>
                      <td className={TABLE_TD}>{doc.supplierInvoiceNo ?? '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(doc.subtotalExcl)}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <span className={doc.status === 'cancelled' ? 'text-faint line-through' : 'text-ink'}>
                          {formatMoney(doc.totalIncl)}
                        </span>
                      </td>
                      <td className={TABLE_TD}>
                        <span title={doc.cancelReason ?? undefined}>
                          <Badge tone={STATUS_TONE[doc.status] ?? 'neutral'}>
                            {doc.fulfilmentStatus === 'part_received' && doc.status === 'issued'
                              ? 'Part received'
                              : doc.status}
                          </Badge>
                        </span>
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

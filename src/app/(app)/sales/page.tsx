import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import {
  listDocuments,
  toDocStatus,
  DOC_LABELS,
  type SalesDocStatus,
} from '@/lib/site/salesDocuments'
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

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/*
 * There is no "void" status, deliberately.
 *
 * On a till, staff already know "void" as removing a line or clearing the
 * basket — things that happen BEFORE a sale posts, where nothing is recorded
 * and nothing remains. A posted sale being undone is the opposite: it keeps
 * its number, its lines and a stated reason forever.
 *
 * Same word, two meanings, and the one people learn first is the wrong one
 * here. So a posted sale is CANCELLED, and "void" is left to mean what the
 * counter already thinks it means. Migration 022 merged the stored values.
 */
const STATUS_LABELS: Record<SalesDocStatus, string> = {
  draft: 'Draft',
  parked: 'Parked',
  issued: 'Issued',
  finalised: 'Finalised',
  cancelled: 'Cancelled',
}

const STATUS_TONE: Record<SalesDocStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  parked: 'warning',
  issued: 'neutral',
  finalised: 'success',
  cancelled: 'danger',
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; from?: string; to?: string; page?: string }>
}) {
  const siteId = await requireSiteId()
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
  const { items: todayDocs } = await listDocuments(siteId, {
    docTypes: ['invoice', 'credit_sale'],
    statuses: ['finalised'],
    from: today,
    to: today,
    limit: 500,
  })
  const takings = todayDocs.reduce((sum, d) => sum + d.totalIncl, 0)

  const href = hrefBuilder('/sales', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

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

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
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
          label="Parked"
          value={String(items.filter((d) => d.status === 'parked').length)}
          hint="Waiting to be recalled"
          tone={items.some((d) => d.status === 'parked') ? 'warning' : 'default'}
          icon={<Icons.Clock size={16} />}
          href={filterHref({ status: 'parked' })}
        />
        <StatTile
          label="Cancelled"
          value={String(items.filter((d) => d.status === 'cancelled').length)}
          hint="On this page"
          tone={items.some((d) => d.status === 'cancelled') ? 'danger' : 'default'}
          icon={<Icons.Ban size={16} />}
          href={filterHref({ status: 'cancelled' })}
        />
      </div>

      <SearchBar
        action="/sales"
        defaultValue={params.q}
        placeholder="Search by document number, customer or reference…"
        keep={{ status: params.status, from: params.from, to: params.to }}
      />

      <FilterBar clearHref="/sales">
        {status && (
          <FilterChip
            label="Status"
            value={STATUS_LABELS[status]}
            clearHref={filterHref({ status: null })}
          />
        )}
        {params.from && (
          <FilterChip label="From" value={params.from} clearHref={filterHref({ from: null })} />
        )}
        {params.to && <FilterChip label="To" value={params.to} clearHref={filterHref({ to: null })} />}
      </FilterBar>

      <div className="flex flex-wrap gap-3 px-6 pb-3 text-xs">
        <Link href="/sales" className={!status ? 'font-medium text-brand' : 'text-muted hover:text-ink'}>
          All
        </Link>
        {(['finalised', 'parked', 'cancelled'] as SalesDocStatus[]).map((value) => (
          <Link
            key={value}
            href={filterHref({ status: status === value ? null : value })}
            className={status === value ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
          >
            {STATUS_LABELS[value]}
          </Link>
        ))}
      </div>

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No sales yet"
              hint="Ring one up from the till to see it here."
              icon={<Icons.Receipt size={22} />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Number</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Customer</th>
                    <th className={TABLE_TH}>Till</th>
                    <th className={TABLE_TH}>Cashier</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((doc) => (
                    <tr key={doc.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link href={`/sales/${doc.id}`} className="text-brand hover:underline">
                          {doc.documentNumber ?? `Draft #${doc.id}`}
                        </Link>
                        {doc.docType !== 'invoice' && (
                          <div className="text-xs text-muted">{DOC_LABELS[doc.docType]}</div>
                        )}
                      </td>
                      <td className={TABLE_TD}>{doc.documentDate}</td>
                      <td className={TABLE_TD}>{doc.customerName ?? 'Walk-in'}</td>
                      <td className={TABLE_TD}>{doc.terminalCode ?? '—'}</td>
                      <td className={TABLE_TD}>{doc.userName || '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <span className={doc.status === 'cancelled' ? 'text-faint line-through' : 'text-ink'}>
                          {formatMoney(doc.totalIncl)}
                        </span>
                      </td>
                      <td className={TABLE_TD}>
                        <span title={doc.cancelReason ?? undefined}>
                          <Badge tone={STATUS_TONE[doc.status]}>{STATUS_LABELS[doc.status]}</Badge>
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

import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listLaybys, LAYBY_STATUS_LABELS, type LaybyStatus } from '@/lib/site/laybys'
import { formatMoney } from '@/lib/decimals'
import { percentPaid } from '@/lib/laybyRules'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
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
import ExpireButton from './ExpireButton'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const TONE: Record<LaybyStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  open: 'brand',
  completed: 'success',
  cancelled: 'neutral',
  expired: 'danger',
}

export default async function LaybysPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams

  const status = (['open', 'completed', 'cancelled', 'expired'] as const).find(
    (s) => s === params.status,
  )
  const page = pageFrom(params.page)

  const { items, total } = await listLaybys(siteId, {
    status,
    q: params.q,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  const { items: open } = await listLaybys(siteId, { status: 'open', limit: 500 })
  const today = new Date().toISOString().slice(0, 10)
  const overdue = open.filter((l) => l.dueDate && l.dueDate < today)
  const held = open.reduce((sum, l) => sum + l.paidTotal, 0)
  const committed = open.reduce((sum, l) => sum + l.outstanding, 0)

  const href = hrefBuilder('/sales/laybys', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  return (
    <>
      <PageHeader
        title="Lay-bys"
        subtitle={`${total} lay-by${total === 1 ? '' : 's'}`}
        action={<ExpireButton />}
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Open"
          value={String(open.length)}
          hint="Being paid off"
          icon={<Icons.Package size={16} />}
          href={filterHref({ status: 'open' })}
        />
        {/* The figure a manager needs to understand and most systems hide:
            this is money in the bank that is not the shop's. */}
        <StatTile
          label="Customers' money held"
          value={formatMoney(held)}
          hint="Refundable — not yet earned"
          tone={held > 0 ? 'warning' : 'default'}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Still to collect"
          value={formatMoney(committed)}
          hint="Before the goods go out"
          icon={<Icons.HandCoins size={16} />}
        />
        <StatTile
          label="Past due"
          value={String(overdue.length)}
          hint={overdue.length > 0 ? 'Chase these' : 'Nothing overdue'}
          tone={overdue.length > 0 ? 'danger' : 'default'}
          icon={<Icons.Clock size={16} />}
        />
      </div>

      <SearchBar
        action="/sales/laybys"
        defaultValue={params.q}
        placeholder="Search by lay-by number or customer…"
        keep={{ status: params.status }}
      />

      <FilterBar clearHref="/sales/laybys">
        {status && (
          <FilterChip
            label="Status"
            value={LAYBY_STATUS_LABELS[status]}
            clearHref={filterHref({ status: null })}
          />
        )}
      </FilterBar>

      <div className="flex flex-wrap gap-3 px-6 pb-3 text-xs">
        <Link
          href="/sales/laybys"
          className={!status ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          All
        </Link>
        {(['open', 'completed', 'cancelled', 'expired'] as LaybyStatus[]).map((value) => (
          <Link
            key={value}
            href={filterHref({ status: status === value ? null : value })}
            className={status === value ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
          >
            {LAYBY_STATUS_LABELS[value]}
          </Link>
        ))}
      </div>

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No lay-bys"
              hint="Start one from the till: ring up the goods, attach a customer, then Save as lay-by."
              icon={<Icons.Package size={22} />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Number</th>
                    <th className={TABLE_TH}>Customer</th>
                    <th className={TABLE_TH}>Due</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                    <th className={`${TABLE_TH} text-right`}>Paid</th>
                    <th className={`${TABLE_TH} text-right`}>Outstanding</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((layby) => {
                    const late = layby.status === 'open' && layby.dueDate && layby.dueDate < today
                    return (
                      <tr key={layby.id} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <Link
                            href={`/sales/laybys/${layby.id}`}
                            className="text-brand hover:underline"
                          >
                            {layby.laybyNumber ?? `#${layby.id}`}
                          </Link>
                          <div className="text-xs text-muted">
                            {percentPaid(layby)}% paid
                          </div>
                        </td>
                        <td className={TABLE_TD}>{layby.customerName ?? '—'}</td>
                        <td className={TABLE_TD}>
                          {layby.dueDate ? (
                            <span className={late ? 'text-danger' : undefined}>{layby.dueDate}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(layby.totalIncl)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(layby.paidTotal)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {layby.outstanding > 0 ? (
                            <span className="text-ink">{formatMoney(layby.outstanding)}</span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className={TABLE_TD}>
                          <Badge tone={TONE[layby.status]}>
                            {LAYBY_STATUS_LABELS[layby.status]}
                          </Badge>
                        </td>
                      </tr>
                    )
                  })}
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

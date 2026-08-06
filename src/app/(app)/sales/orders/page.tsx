import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import {
  listOrders,
  FULFILMENT_LABELS,
  FULFILMENT_STATUSES,
  type FulfilmentStatus,
} from '@/lib/site/salesOrders'
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

const TONE: Record<FulfilmentStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  open: 'brand',
  part_delivered: 'warning',
  delivered: 'success',
  cancelled: 'neutral',
}

function toFulfilment(value: unknown): FulfilmentStatus | 'outstanding' | undefined {
  const raw = String(value ?? '')
  if (raw === 'outstanding') return 'outstanding'
  return (FULFILMENT_STATUSES as readonly string[]).includes(raw)
    ? (raw as FulfilmentStatus)
    : undefined
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; fulfilment?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams

  const fulfilment = toFulfilment(params.fulfilment)
  const page = pageFrom(params.page)

  const { items, total } = await listOrders(siteId, {
    fulfilment,
    q: params.q,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  // The numbers a manager opens this screen for: what is still promised, and
  // what is overdue for delivery.
  const { items: openOrders } = await listOrders(siteId, { fulfilment: 'outstanding', limit: 500 })
  const today = new Date().toISOString().slice(0, 10)
  const late = openOrders.filter((o) => o.deliveryDate && o.deliveryDate < today)
  const committed = openOrders.reduce((sum, o) => sum + o.totalIncl, 0)

  const href = hrefBuilder('/sales/orders', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  return (
    <>
      <PageHeader
        title="Sales orders"
        subtitle={`${total} order${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/sales/new">
            <Icons.Plus size={15} />
            New order at the till
          </PrimaryLink>
        }
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Outstanding orders"
          value={String(openOrders.length)}
          hint="Still to be delivered"
          icon={<Icons.ListOrdered size={16} />}
          href={filterHref({ fulfilment: 'outstanding' })}
        />
        <StatTile
          label="Value committed"
          value={formatMoney(committed)}
          hint="Ordered but not yet invoiced"
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Past delivery date"
          value={String(late.length)}
          hint={late.length > 0 ? 'Customers are waiting' : 'Nothing overdue'}
          tone={late.length > 0 ? 'warning' : 'default'}
          icon={<Icons.Clock size={16} />}
        />
        <StatTile
          label="Units reserved"
          value={String(
            Math.round(openOrders.reduce((sum, o) => sum + (o.reservesStock ? o.qtyOutstanding : 0), 0) * 1000) / 1000,
          )}
          hint="Held off available stock"
          icon={<Icons.Boxes size={16} />}
        />
      </div>

      <SearchBar
        action="/sales/orders"
        defaultValue={params.q}
        placeholder="Search by order number, customer or their order number…"
        keep={{ fulfilment: params.fulfilment }}
      />

      <FilterBar clearHref="/sales/orders">
        {fulfilment && (
          <FilterChip
            label="Status"
            value={fulfilment === 'outstanding' ? 'Outstanding' : FULFILMENT_LABELS[fulfilment]}
            clearHref={filterHref({ fulfilment: null })}
          />
        )}
      </FilterBar>

      <div className="flex flex-wrap gap-3 px-6 pb-3 text-xs">
        <Link
          href="/sales/orders"
          className={!fulfilment ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          All
        </Link>
        <Link
          href={filterHref({ fulfilment: fulfilment === 'outstanding' ? null : 'outstanding' })}
          className={fulfilment === 'outstanding' ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          Outstanding
        </Link>
        {FULFILMENT_STATUSES.map((value) => (
          <Link
            key={value}
            href={filterHref({ fulfilment: fulfilment === value ? null : value })}
            className={fulfilment === value ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
          >
            {FULFILMENT_LABELS[value]}
          </Link>
        ))}
      </div>

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No sales orders"
              hint="Raise one when a customer commits to buy something you will deliver later."
              icon={<Icons.ListOrdered size={22} />}
              action={
                <PrimaryLink href="/sales/new">
                  <Icons.Plus size={15} />
                  New order at the till
                </PrimaryLink>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Order</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Customer</th>
                    <th className={TABLE_TH}>Deliver by</th>
                    <th className={`${TABLE_TH} text-right`}>Ordered</th>
                    <th className={`${TABLE_TH} text-right`}>Outstanding</th>
                    <th className={`${TABLE_TH} text-right`}>Value</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((order) => {
                    const overdue =
                      order.deliveryDate !== null &&
                      order.deliveryDate < today &&
                      (order.fulfilmentStatus === 'open' || order.fulfilmentStatus === 'part_delivered')

                    return (
                      <tr key={order.id} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <Link href={`/sales/orders/${order.id}`} className="text-brand hover:underline">
                            {order.documentNumber ?? `Order #${order.id}`}
                          </Link>
                          {order.customerOrderNo && (
                            <div className="text-xs text-muted">Their ref {order.customerOrderNo}</div>
                          )}
                        </td>
                        <td className={TABLE_TD}>{order.documentDate}</td>
                        <td className={TABLE_TD}>{order.customerName ?? 'Walk-in'}</td>
                        <td className={TABLE_TD}>
                          {order.deliveryDate ? (
                            <span className={overdue ? 'text-warning' : undefined}>
                              {order.deliveryDate}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{order.qtyOrdered}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {order.qtyOutstanding > 0 ? (
                            <span className="text-ink">{order.qtyOutstanding}</span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(order.totalIncl)}</td>
                        <td className={TABLE_TD}>
                          <div className="flex items-center gap-2">
                            <Badge tone={TONE[order.fulfilmentStatus]}>
                              {FULFILMENT_LABELS[order.fulfilmentStatus]}
                            </Badge>
                            {!order.reservesStock &&
                              (order.fulfilmentStatus === 'open' ||
                                order.fulfilmentStatus === 'part_delivered') && (
                                <span className="text-xs text-muted" title="This order no longer holds stock.">
                                  not reserving
                                </span>
                              )}
                          </div>
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

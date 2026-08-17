import type { ReactNode } from 'react'
import { requireCapability } from '@/lib/auth'
import {
  listOrders,
  FULFILMENT_LABELS,
  FULFILMENT_STATUSES,
  type FulfilmentStatus,
} from '@/lib/site/salesOrders'
import { formatMoney, formatQty } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  StatTile,
  StatStrip,
  LinkSegmentedControl,
  TableToolbar,
  Pagination,
  Icons,
} from '@/components/ui'
import OrdersTable, { type OrderTableRow } from './OrdersTable'
import NewOrderButton from './NewOrderButton'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * A glyph per fulfilment slice, echoing the outcome each one holds — everything,
 * a worklist, in transit, part-way, arrived, called off. Six segments is at the
 * top of what a bar can carry, and the shapes are what keep it scannable once
 * the labels start blurring together.
 */
const FULFILMENT_ICONS: Record<FulfilmentStatus | 'all' | 'outstanding', ReactNode> = {
  all: <Icons.LayoutGrid size={15} />,
  outstanding: <Icons.List size={15} />,
  open: <Icons.Truck size={15} />,
  part_delivered: <Icons.Clock size={15} />,
  delivered: <Icons.StatusSuccess size={15} />,
  cancelled: <Icons.StatusFailure size={15} />,
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

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the table lives in OrdersTable and gets plain rows.
  const rows: OrderTableRow[] = items.map((order) => ({
    id: order.id,
    documentNumber: order.documentNumber,
    customerOrderNo: order.customerOrderNo,
    documentDate: order.documentDate,
    customerName: order.customerName,
    deliveryDate: order.deliveryDate,
    fulfilmentStatus: order.fulfilmentStatus,
    fulfilmentLabel: FULFILMENT_LABELS[order.fulfilmentStatus],
    reservesStock: order.reservesStock,
    qtyOrdered: order.qtyOrdered,
    qtyOutstanding: order.qtyOutstanding,
    totalIncl: order.totalIncl,
  }))

  const filtered = Boolean(fulfilment)
  const filterLabel =
    fulfilment === 'outstanding'
      ? 'Outstanding'
      : fulfilment
        ? FULFILMENT_LABELS[fulfilment]
        : undefined

  return (
    <>
      <PageHeader
        title="Sales orders"
        icon={<Icons.ListOrdered size={18} />}
        subtitle={`${total} order${total === 1 ? '' : 's'}`}
        action={
          <NewOrderButton />
        }
      />

      <PageBody>
        <StatStrip columns={4}>
          <StatTile
            label="Outstanding orders"
            value={String(openOrders.length)}
            hint="Still to be delivered"
            icon={<Icons.ListOrdered size={20} />}
            href={filterHref({ fulfilment: 'outstanding' })}
          />
          <StatTile
            label="Value committed"
            value={formatMoney(committed)}
            hint="Ordered but not yet invoiced"
            iconTone="success"
            icon={<Icons.Coins size={20} />}
          />
          <StatTile
            label="Past delivery date"
            value={String(late.length)}
            hint={late.length > 0 ? 'Customers are waiting' : 'Nothing overdue'}
            tone={late.length > 0 ? 'warning' : 'default'}
            icon={<Icons.Clock size={20} />}
          />
          <StatTile
            label="Units reserved"
            value={formatQty(
              openOrders.reduce((sum, o) => sum + (o.reservesStock ? o.qtyOutstanding : 0), 0),
            )}
            hint="Held off available stock"
            icon={<Icons.Boxes size={20} />}
          />
        </StatStrip>

        {/* One toolbar row, filters left and search right — the same rhythm as
            the invoice register. The search used to sit on its own line above,
            negative-margined out of PageBody's gutter to line up, which left a
            stray band of whitespace between the strip and the filters. */}
        <TableToolbar
          actions={
            <div className="w-80">
              <SearchBar
                action="/sales/orders"
                defaultValue={params.q}
                placeholder="Search order number, customer or their order number…"
                className="p-0"
                keep={{ fulfilment: params.fulfilment }}
              />
            </div>
          }
        >
          <LinkSegmentedControl
            aria-label="Filter by fulfilment"
            value={fulfilment ?? 'all'}
            options={[
              {
                value: 'all',
                label: 'All',
                icon: FULFILMENT_ICONS.all,
                href: filterHref({ fulfilment: null }),
              },
              {
                value: 'outstanding',
                label: 'Outstanding',
                icon: FULFILMENT_ICONS.outstanding,
                href: filterHref({ fulfilment: 'outstanding' }),
              },
              ...FULFILMENT_STATUSES.map((value) => ({
                value,
                label: FULFILMENT_LABELS[value],
                icon: FULFILMENT_ICONS[value],
                href: filterHref({ fulfilment: value }),
              })),
            ]}
          />
        </TableToolbar>

        <Card>
          <OrdersTable
            rows={rows}
            today={today}
            empty={
              params.q
                ? {
                    icon: <Icons.Search size={22} />,
                    title: `Nothing matches “${params.q}”`,
                    hint: 'Try a different order number, customer or their order number.',
                    action: (
                      <ButtonLink href="/sales/orders" variant="secondary">
                        Clear the search
                      </ButtonLink>
                    ),
                  }
                : filtered
                  ? {
                      icon: <Icons.ListOrdered size={22} />,
                      title: `No ${filterLabel?.toLowerCase()} orders`,
                      hint: 'Nothing is in this slice right now.',
                      action: (
                        <ButtonLink href="/sales/orders" variant="secondary">
                          Show all orders
                        </ButtonLink>
                      ),
                    }
                  : {
                      icon: <Icons.ListOrdered size={22} />,
                      title: 'No sales orders',
                      hint: 'Raise one when a customer commits to buy something you will deliver later.',
                      action: (
                        <NewOrderButton />
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

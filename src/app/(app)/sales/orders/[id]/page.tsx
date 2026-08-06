import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getOrder, FULFILMENT_LABELS, type FulfilmentStatus } from '@/lib/site/salesOrders'
import { availableToSell } from '@/lib/site/stockMovements'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import DeliverPanel from './DeliverPanel'

export const dynamic = 'force-dynamic'

const TONE: Record<FulfilmentStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  open: 'brand',
  part_delivered: 'warning',
  delivered: 'success',
  cancelled: 'neutral',
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const order = await getOrder(siteId, id)
  if (!order) notFound()

  const status = order.details?.fulfilmentStatus ?? 'open'
  const productIds = order.lines.map((l) => l.productId).filter((p): p is number => p !== null)
  const availability = await availableToSell(siteId, productIds)

  const canDeliver = status === 'open' || status === 'part_delivered'

  return (
    <>
      <PageHeader
        title={order.document.documentNumber ?? `Order #${order.document.id}`}
        subtitle={`${order.document.customerName ?? 'Walk-in'} · ${order.document.documentDate}`}
        backHref="/sales/orders"
        backLabel="Sales orders"
        action={<Badge tone={TONE[status]}>{FULFILMENT_LABELS[status]}</Badge>}
      />

      <PageBody>
        {status === 'cancelled' && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Ban size={18} className="mt-0.5 shrink-0 text-muted" />
              <div>
                <p className="font-medium text-ink">This order was cancelled.</p>
                <p className="text-sm text-muted">
                  Nothing was reversed — an order never moves stock or posts to the ledger, so
                  cancelling one only releases what it was holding.
                </p>
              </div>
            </div>
          </Card>
        )}

        {order.details && !order.details.reservesStock && canDeliver && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="font-medium text-ink">This order is no longer holding stock.</p>
                <p className="text-sm text-muted">
                  Its reservation expired, so the goods are available to anyone. It can still be
                  delivered if the stock is there.
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Ordered"
            value={String(order.qtyOrdered)}
            hint={formatMoney(order.document.totalIncl)}
            icon={<Icons.ListOrdered size={16} />}
          />
          <StatTile
            label="Delivered"
            value={String(order.qtyDelivered)}
            hint={`${order.deliveries.length} invoice${order.deliveries.length === 1 ? '' : 's'}`}
            tone={order.qtyDelivered > 0 ? 'positive' : 'default'}
            icon={<Icons.Truck size={16} />}
          />
          <StatTile
            label="Outstanding"
            value={String(order.qtyOutstanding)}
            hint={order.qtyOutstanding > 0 ? 'Still promised' : 'Nothing left'}
            tone={order.qtyOutstanding > 0 ? 'warning' : 'default'}
            icon={<Icons.Clock size={16} />}
          />
          <StatTile
            label="Deliver by"
            value={order.details?.deliveryDate ?? '—'}
            hint={order.details?.customerOrderNo ? `Their ref ${order.details.customerOrderNo}` : 'No date set'}
            icon={<Icons.Calendar size={16} />}
          />
        </div>

        <DeliverPanel
          documentId={order.document.id}
          canDeliver={canDeliver}
          fulfilmentStatus={status}
          deliveryDate={order.details?.deliveryDate ?? null}
          expiresAt={order.details?.expiresAt ? order.details.expiresAt.toISOString().slice(0, 10) : null}
          customerOrderNo={order.details?.customerOrderNo ?? null}
          reservesStock={order.details?.reservesStock ?? true}
          lines={order.lines.map((line) => ({
            id: line.id,
            description: line.description,
            productCode: line.productCode,
            qty: line.qty,
            qtyDelivered: line.qtyDelivered,
            qtyOutstanding: line.qtyOutstanding,
            unitPriceIncl: line.unitPriceIncl,
            onHand: line.productId ? (availability.get(line.productId)?.onHand ?? null) : null,
            available: line.productId ? (availability.get(line.productId)?.available ?? null) : null,
          }))}
        />

        <Card>
          <CardHeader
            title="Deliveries"
            description="Each delivery raises its own invoice against this order."
          />
          {order.deliveries.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">
                Nothing delivered yet. Stock is reserved but has not moved.
              </p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Invoice</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={`${TABLE_TH} text-right`}>Value</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {order.deliveries.map((delivery) => (
                    <tr key={delivery.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link href={`/sales/${delivery.id}`} className="text-brand hover:underline">
                          {delivery.documentNumber ?? `Draft #${delivery.id}`}
                        </Link>
                      </td>
                      <td className={TABLE_TD}>{delivery.documentDate}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(delivery.totalIncl)}
                      </td>
                      <td className={TABLE_TD}>
                        <Badge tone={delivery.status === 'finalised' ? 'success' : 'warning'}>
                          {delivery.status === 'finalised' ? 'Invoiced' : 'Awaiting payment'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}

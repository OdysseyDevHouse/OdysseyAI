import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getOrder, FULFILMENT_LABELS, type FulfilmentStatus } from '@/lib/site/salesOrders'
import { availableToSell } from '@/lib/site/stockMovements'
import { isEditable } from '@/lib/site/salesDocuments'
import { liveSpecials } from '@/lib/site/specials'
import { listPriceStructures, repsForLines } from '@/lib/site/lookups'
import { listUsers } from '@/lib/site/users'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getNumericSetting } from '@/lib/site/settings'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import InvoiceEditor from '../../invoicing/[id]/InvoiceEditor'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  StatTile,
  StatStrip,
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
  const { site, user, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'sales.view')) redirect('/not-allowed')
  const siteId = site.id
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const order = await getOrder(siteId, id)
  if (!order) notFound()

  const status = order.details?.fulfilmentStatus ?? 'open'
  const productIds = order.lines.map((l) => l.productId).filter((p): p is number => p !== null)

  /*
   * Everything the shared editor needs, alongside the order's own figures.
   *
   * Loaded unconditionally rather than behind the `editable` check below: the
   * queries are the same handful the invoicing and quotes screens already make,
   * and branching a Promise.all to save them on a delivered order would trade a
   * few milliseconds for a second code path.
   */
  const [availability, structures, users, tenders, cashRounding, specials] = await Promise.all([
    availableToSell(siteId, productIds),
    listPriceStructures(siteId),
    listUsers(siteId),
    listTenderTypes(siteId),
    getNumericSetting(siteId, 'sales_cash_rounding'),
    // An order is priced like an invoice, so it sees the same promotions.
    liveSpecials(siteId),
  ])

  const canDeliver = status === 'open' || status === 'part_delivered'

  /*
   * Editable while nothing has gone out and the shop still owns the promise.
   *
   * Three conditions, and each is a different reason to stop: the document
   * itself must be unposted, the order must not be delivered or cancelled —
   * the same pair `setOrderDetails` refuses — and NOTHING may have been
   * delivered yet, because a part-delivered order has invoices against these
   * lines and stock that has already left.
   */
  const editable =
    isEditable(order.document.status) &&
    status !== 'delivered' &&
    status !== 'cancelled' &&
    order.qtyDelivered === 0 &&
    can(capabilities, 'sales.edit')

  // Whoever is capturing is pre-selected on every new line, as on an invoice.
  const { reps, defaultUserId } = repsForLines(users, user.id)

  const customer = order.document.customerId
    ? await getTillCustomer(siteId, order.document.customerId)
    : null

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
        {/* A cancelled order is a closed fact, not a problem — neutral. */}
        {status === 'cancelled' && (
          <Callout tone="neutral" icon={<Icons.Ban size={18} />} title="This order was cancelled.">
            Nothing was reversed — an order never moves stock or posts to the ledger, so
            cancelling one only releases what it was holding.
          </Callout>
        )}

        {/* An expired reservation needs attention before delivery — warning. */}
        {order.details && !order.details.reservesStock && canDeliver && (
          <Callout tone="warning" title="This order is no longer holding stock.">
            Its reservation expired, so the goods are available to anyone. It can still be
            delivered if the stock is there.
          </Callout>
        )}

        <StatStrip columns={4}>
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
        </StatStrip>

        {/*
          ── THE LINES, WHILE THEY ARE STILL THE SHOP'S TO CHANGE ────────────

          An order is captured on the same editor as an invoice and a quote,
          because it is the same document at an earlier moment — see the quotes
          screen, which does exactly this.

          It appears only while NOTHING HAS BEEN DELIVERED. Once a delivery has
          gone out, stock has moved and an invoice exists against these lines;
          editing them then would change what a customer has already been given
          — the same class of mistake as editing a posted invoice. The panel
          below is what an order in that state needs, and it stays either way.

          `setOrderDetails` refuses a delivered or cancelled order server-side,
          so this is the screen agreeing with a rule rather than inventing one.
        */}
        {editable && (
          <InvoiceEditor
            document={order.document}
            structures={structures}
            reps={reps}
            defaultRepUserId={defaultUserId}
            tenders={tenders}
            cashRounding={cashRounding}
            specials={specials}
            customer={customer}
            editable
            canOverrideDiscount={can(capabilities, 'sales.discount_override')}
            canOverridePrice={can(capabilities, 'sales.price_override')}
            showCost={can(capabilities, 'products.cost')}
          />
        )}

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
            <EmptyState
              icon={<Icons.Truck size={22} />}
              title="Nothing delivered yet"
              hint="Stock is reserved but has not moved. Deliver lines above to raise the first invoice."
            />
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

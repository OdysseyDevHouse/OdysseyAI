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
import InvoiceEditor from '@/app/(invoicing)/invoicing/[id]/InvoiceEditor'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Callout,
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
      {/*
        ── ONE HEADING, AND THE EDITOR OWNS IT ─────────────────────────────

        This page used to carry its own PageHeader, which was right while it
        was a read-only screen. The editor brings one too — so an order opened
        with the grid on it showed "Order #31" twice, each with its own back
        arrow, reading as an order inside an order.

        The quotes screen has never had this problem because it has no header
        of its own: the editor names the document, and QuotePanel is a card
        below it. This now does the same.

        A DELIVERED order has no editor, so it would have no heading at all —
        hence the fallback below rather than simply deleting this.
      */}
      {/*
        The page draws its own header ONLY when there is no editor to draw one.
        A delivered order is past editing, so the grid is gone and this is the
        only thing that would name the document.

        While it IS editable the editor owns the heading, and takes the
        fulfilment badge as `extraStatus` so all four — Open, Draft, Save
        (draft), Save order — sit on one line beside the title, rather than a
        lone pill floating above it.
      */}
      {!editable && (
        <PageHeader
          title={order.document.documentNumber ?? `Order #${order.document.id}`}
          subtitle={`${order.document.customerName ?? 'Walk-in'} · ${order.document.documentDate}`}
          backHref="/invoicing/orders"
          backLabel="Sales orders"
          action={<Badge tone={TONE[status]}>{FULFILMENT_LABELS[status]}</Badge>}
        />
      )}

      {/*
        ── THE LINES, WHILE THEY ARE STILL THE SHOP'S TO CHANGE ──────────────

        Captured on the same editor as an invoice and a quote, because it is the
        same document at an earlier moment.

        RENDERED OUTSIDE PageBody, and that is not a detail. The editor brings
        its own PageHeader and its own PageBody — so wrapping it in a second one
        padded its content twice, leaving the customer bar and the grid visibly
        narrower than the delivery panel below them, and dropped a page header
        inside a body where it read as a card title rather than a heading.

        `editorOnly` is what stops it drawing a SECOND heading under this
        page's. The quotes screen solves the same collision by having no header
        of its own; an order needs one, because a delivered order has no editor
        at all and would otherwise be untitled.
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
          /* The fulfilment state, on the same line as the document's own. Two
             questions, two badges: "has any of this gone out" and "has it been
             saved". */
          extraStatus={<Badge tone={TONE[status]}>{FULFILMENT_LABELS[status]}</Badge>}
          canOverrideDiscount={can(capabilities, 'sales.discount_override')}
          canOverridePrice={can(capabilities, 'sales.price_override')}
          showCost={can(capabilities, 'products.cost')}
          /* The delivery panel and callouts follow below, so the editor must
             not close the page with its own pb-10. */
          hasSectionsBelow
        />
      )}

      {/* The gutter matches the editor's own PageBody above, so the delivery
          panel lines up with the grid rather than sitting wider than it. */}
      <div className="flex flex-col gap-5 px-6 pt-5 pb-10">
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

        {/*
          ── NO STAT STRIP HERE ──────────────────────────────────────────────

          A document screen is for working ON the document. Four tiles counting
          what this one order has delivered are a dashboard, and on a new order
          they are four zeros sitting above the thing somebody actually came to
          do.

          Those figures belong on the REGISTER, which is where a manager asks
          "what is outstanding across everything" — and that screen already
          carries them.

          What is genuinely per-document and still needed is below: the delivery
          panel, which lists each line with its ordered, delivered, outstanding
          and available quantities. That is the same information at the
          resolution somebody delivering actually works at.
        */}

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
      </div>
    </>
  )
}

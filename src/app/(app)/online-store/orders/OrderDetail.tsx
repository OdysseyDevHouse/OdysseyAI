'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  EmptyState,
  Icons,
  Modal,
  Skeleton,
  TableSkeleton,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { OnlineOrderDetail } from '@/lib/site/onlineOrders'
import { getOrderAction } from './detailAction'

/**
 * One order, as the customer submitted it.
 *
 * This shows the REQUEST, not the sale — the prices here are what the shopper
 * was shown, which is exactly why they are worth keeping after acceptance
 * re-prices everything. When the two disagree, this is the screen that says
 * what the customer thought they were buying.
 */
export default function OrderDetail({
  orderId,
  onClose,
}: {
  orderId: number | null
  onClose: () => void
}) {
  const [order, setOrder] = useState<OnlineOrderDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const requestId = useRef(0)

  useEffect(() => {
    if (orderId === null) return
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    setOrder(null)

    getOrderAction(orderId)
      .then((result) => {
        if (id !== requestId.current) return
        if (!result.ok) setError(result.error)
        else setOrder(result.order)
      })
      .catch(() => {
        if (id === requestId.current) setError('Could not load that order.')
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [orderId])

  const goodsTotal =
    order?.lines.reduce((sum, l) => sum + l.lineTotalIncl, 0) ?? 0

  return (
    <Modal
      open={orderId !== null}
      onClose={onClose}
      size="lg"
      title={order ? `Order ${order.orderNumber}` : 'Order'}
      description={
        order
          ? `Placed ${order.placedAt.toLocaleString('en-ZA', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : undefined
      }
    >
      {error ? (
        <EmptyState icon={<Icons.StatusError size={22} />} title="Couldn't load" hint={error} />
      ) : loading || !order ? (
        /* The same shape as the loaded order — badges, two detail columns,
           the lines table — so the modal keeps its height instead of
           collapsing to a spinner and jumping when the data lands. */
        <div aria-hidden className="flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-24 rounded-pill" />
            <Skeleton className="h-6 w-20 rounded-pill" />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
          <TableSkeleton columns={4} rows={4} />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={order.statusTone}>{order.statusName}</Badge>
            <Badge tone="neutral">
              {order.fulfilment === 'deliver' ? 'Delivery' : 'Collection'}
            </Badge>
            {order.isArchived && <Badge tone="neutral">Archived</Badge>}
            {order.documentId && (
              <Link
                href={
                  order.documentNumber
                    ? `/sales/${order.documentId}`
                    : `/invoicing/${order.documentId}`
                }
                className="text-sm font-medium text-brand hover:underline"
              >
                {order.documentNumber ?? 'Draft sale'}
              </Link>
            )}
            {/* Refunds go through an ordinary credit note against the online
                tender (153) — this records the money owed back; paying it back
                is a person in the PayFast dashboard, referenced on the note. */}
            {order.documentId && order.documentNumber && (
              <Link
                href={`/sales/${order.documentId}/credit`}
                className="text-sm font-medium text-brand hover:underline"
              >
                Refund / credit note
              </Link>
            )}
          </div>

          {order.declineReason && (
            <div className="rounded-card border border-danger bg-danger-soft px-4 py-3">
              <p className="text-sm font-medium text-danger-ink">Cancelled</p>
              <p className="text-sm text-danger-ink">{order.declineReason}</p>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">Customer</h3>
              <dl className="mt-1.5 flex flex-col gap-0.5 text-sm">
                <div className="flex gap-2">
                  <dt className="text-muted">Name</dt>
                  <dd className="ml-auto text-ink">{order.contactName || 'Guest'}</dd>
                </div>
                {order.contactPhone && (
                  <div className="flex gap-2">
                    <dt className="text-muted">Phone</dt>
                    <dd className="ml-auto text-ink">{order.contactPhone}</dd>
                  </div>
                )}
                {order.contactEmail && (
                  <div className="flex gap-2">
                    <dt className="text-muted">Email</dt>
                    <dd className="ml-auto truncate text-ink">{order.contactEmail}</dd>
                  </div>
                )}
              </dl>
            </div>

            {order.fulfilment === 'deliver' && (
              <div>
                <h3 className="text-sm font-semibold text-ink">Deliver to</h3>
                <p className="mt-1.5 text-sm text-ink-2">
                  {[
                    order.deliveryLine1,
                    order.deliveryLine2,
                    order.deliverySuburb,
                    order.deliveryPostcode,
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </p>
                {order.deliveryNotes && (
                  <p className="mt-1 text-sm text-muted">{order.deliveryNotes}</p>
                )}
              </div>
            )}
          </div>

          {order.customerNote && (
            <div className="rounded-card bg-surface-2 px-4 py-3">
              <p className="text-sm font-medium text-ink">Note from the customer</p>
              <p className="text-sm text-ink-2">{order.customerNote}</p>
            </div>
          )}

          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-ink">
              What they ordered
              <span className="ml-2 font-normal text-muted">at the prices they were shown</span>
            </h3>
            <div className="overflow-x-auto rounded-card border border-border">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Item</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Qty</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Price</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td className={TABLE_TD}>
                        <span className="text-ink">{line.description}</span>
                        {line.productCode && (
                          <span className="ml-2 text-xs text-muted">{line.productCode}</span>
                        )}
                        {line.lineNote && (
                          <span className="block text-xs text-muted">{line.lineNote}</span>
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty)}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(line.unitPriceIncl)}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(line.lineTotalIncl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="mt-3 flex flex-col gap-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Goods</dt>
                <dd className="numeric text-ink">{formatMoney(goodsTotal)}</dd>
              </div>
              {order.deliveryFeeIncl > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Delivery</dt>
                  <dd className="numeric text-ink">{formatMoney(order.deliveryFeeIncl)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t border-border pt-1">
                <dt className="font-medium text-ink">Order total</dt>
                <dd className="numeric font-semibold text-ink">{formatMoney(order.totalIncl)}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </Modal>
  )
}

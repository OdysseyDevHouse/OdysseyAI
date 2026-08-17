'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { FulfilmentStatus } from '@/lib/site/salesOrders'
import { formatMoney, formatQty } from '@/lib/decimals'
import { Badge, DataTable, Icons, Menu, MenuItem, type Column } from '@/components/ui'

/**
 * The sales-orders list. A client component only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down pre-formatted, serialisable rows.
 */

const TONE: Record<FulfilmentStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  open: 'brand',
  part_delivered: 'warning',
  delivered: 'success',
  cancelled: 'neutral',
}

export type OrderTableRow = {
  id: number
  documentNumber: string | null
  customerOrderNo: string | null
  documentDate: string
  customerName: string | null
  deliveryDate: string | null
  fulfilmentStatus: FulfilmentStatus
  /** Pre-computed from FULFILMENT_LABELS, which lives in server code. */
  fulfilmentLabel: string
  reservesStock: boolean
  qtyOrdered: number
  qtyOutstanding: number
  totalIncl: number
}

function buildColumns(today: string): readonly Column<OrderTableRow>[] {
  return [
    {
      key: 'order',
      header: 'Order',
      cell: (order) => (
        <>
          <Link href={`/invoicing/orders/${order.id}`} className="text-brand hover:underline">
            {order.documentNumber ?? `Order #${order.id}`}
          </Link>
          {order.customerOrderNo && (
            <div className="text-xs text-muted">Their ref {order.customerOrderNo}</div>
          )}
        </>
      ),
      sortable: true,
      sortValue: (order) => order.documentNumber ?? `#${order.id}`,
    },
    { key: 'date', header: 'Date', sortable: true, cell: (order) => order.documentDate },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      cell: (order) => order.customerName ?? 'Walk-in',
    },
    {
      key: 'deliverBy',
      header: 'Deliver by',
      cell: (order) => {
        if (!order.deliveryDate) return <span className="text-faint">—</span>
        const overdue =
          order.deliveryDate < today &&
          (order.fulfilmentStatus === 'open' || order.fulfilmentStatus === 'part_delivered')
        return <span className={overdue ? 'text-warning' : undefined}>{order.deliveryDate}</span>
      },
      sortable: true,
      sortValue: (order) => order.deliveryDate ?? '',
    },
    {
      key: 'ordered',
      header: 'Ordered',
      numeric: true,
      sortable: true,
      cell: (order) => formatQty(order.qtyOrdered),
      sortValue: (order) => order.qtyOrdered,
    },
    {
      // Zero outstanding is a state, not a value — the badge lets a delivered
      // order pop without anyone reading the digits.
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      sortable: true,
      cell: (order) =>
        order.qtyOutstanding > 0 ? (
          <span className="text-ink">{formatQty(order.qtyOutstanding)}</span>
        ) : (
          <Badge tone="success">Done</Badge>
        ),
      sortValue: (order) => order.qtyOutstanding,
    },
    {
      key: 'value',
      header: 'Value',
      numeric: true,
      sortable: true,
      cell: (order) => formatMoney(order.totalIncl),
      sortValue: (order) => order.totalIncl,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (order) => (
        <div className="flex items-center gap-2">
          {/* Only the fulfilment state takes a dot. "Not reserving" beside it is
              a warning ABOUT the order, not a second state it is in — dotting
              both would present them as two equal states. */}
          <Badge dot tone={TONE[order.fulfilmentStatus]}>
            {order.fulfilmentLabel}
          </Badge>
          {!order.reservesStock &&
            (order.fulfilmentStatus === 'open' ||
              order.fulfilmentStatus === 'part_delivered') && (
              <span title="This order no longer holds stock.">
                <Badge tone="warning">Not reserving</Badge>
              </span>
            )}
        </div>
      ),
      sortable: true,
      sortValue: (order) => order.fulfilmentStatus,
    },
  ]
}

export default function OrdersTable({
  rows,
  today,
  empty,
}: {
  rows: OrderTableRow[]
  /** The server's date, so "overdue" agrees with the stat strip above. */
  today: string
  empty: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }
}) {
  return (
    <DataTable
      columns={buildColumns(today)}
      rows={rows}
      getRowKey={(order) => order.id}
      actions={(order) => (
        <Menu
          iconOnly
          size="sm"
          variant="bare"
          triggerLabel={`Actions for ${order.documentNumber ?? `order #${order.id}`}`}
          label={<Icons.MoreVertical size={16} />}
        >
          <MenuItem href={`/invoicing/orders/${order.id}`}>
            <Icons.Eye size={15} />
            View order
          </MenuItem>
        </Menu>
      )}
      empty={empty}
    />
  )
}

'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { LaybyStatus } from '@/lib/site/laybys'
import { formatMoney } from '@/lib/decimals'
import { percentPaid } from '@/lib/laybyRules'
import { Badge, DataTable, type Column } from '@/components/ui'

/**
 * The lay-bys list. A client component only because DataTable's column cells
 * are functions, which a Server Component cannot pass across the boundary —
 * the page hands down pre-formatted, serialisable rows.
 */

const TONE: Record<LaybyStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'brand'> = {
  open: 'brand',
  completed: 'success',
  cancelled: 'neutral',
  expired: 'danger',
}

export type LaybyTableRow = {
  id: number
  laybyNumber: string | null
  customerName: string | null
  dueDate: string | null
  status: LaybyStatus
  /** Pre-computed from LAYBY_STATUS_LABELS, which lives in server code. */
  statusLabel: string
  totalIncl: number
  paidTotal: number
  outstanding: number
}

function buildColumns(today: string): readonly Column<LaybyTableRow>[] {
  return [
    {
      key: 'number',
      header: 'Number',
      cell: (layby) => (
        <Link href={`/sales/laybys/${layby.id}`} className="text-brand hover:underline">
          {layby.laybyNumber ?? `#${layby.id}`}
        </Link>
      ),
      sortable: true,
      sortValue: (layby) => layby.laybyNumber ?? `#${layby.id}`,
    },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      cell: (layby) => layby.customerName ?? <span className="text-faint">—</span>,
      sortValue: (layby) => layby.customerName ?? '',
    },
    {
      key: 'due',
      header: 'Due',
      cell: (layby) => {
        if (!layby.dueDate) return <span className="text-faint">—</span>
        const late = layby.status === 'open' && layby.dueDate < today
        return <span className={late ? 'text-danger' : undefined}>{layby.dueDate}</span>
      },
      sortable: true,
      sortValue: (layby) => layby.dueDate ?? '',
    },
    {
      // How far along the customer is — danger when the clock has run out on
      // an open lay-by, quiet otherwise.
      key: 'percentPaid',
      header: '% paid',
      numeric: true,
      sortable: true,
      cell: (layby) => {
        const late = layby.status === 'open' && layby.dueDate !== null && layby.dueDate < today
        return (
          <span className={`text-xs ${late ? 'text-danger' : 'text-muted'}`}>
            {percentPaid(layby)}%
          </span>
        )
      },
      sortValue: (layby) => percentPaid(layby),
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      sortable: true,
      cell: (layby) => formatMoney(layby.totalIncl),
      sortValue: (layby) => layby.totalIncl,
    },
    {
      key: 'paid',
      header: 'Paid',
      numeric: true,
      sortable: true,
      cell: (layby) => formatMoney(layby.paidTotal),
      sortValue: (layby) => layby.paidTotal,
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      sortable: true,
      cell: (layby) =>
        layby.outstanding > 0 ? (
          <span className="text-ink">{formatMoney(layby.outstanding)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (layby) => layby.outstanding,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (layby) => <Badge tone={TONE[layby.status]}>{layby.statusLabel}</Badge>,
      sortable: true,
      sortValue: (layby) => layby.status,
    },
  ]
}

export default function LaybysTable({
  rows,
  today,
  empty,
}: {
  rows: LaybyTableRow[]
  /** The server's date, so "late" agrees with the stat strip above. */
  today: string
  empty: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }
}) {
  return (
    <DataTable
      columns={buildColumns(today)}
      rows={rows}
      getRowKey={(layby) => layby.id}
      empty={empty}
    />
  )
}

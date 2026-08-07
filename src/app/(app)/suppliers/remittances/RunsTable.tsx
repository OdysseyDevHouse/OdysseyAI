'use client'

import Link from 'next/link'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

type RunStatus = 'draft' | 'posted' | 'cancelled'

/**
 * The slice of a payment run the list renders — plain data only, so the server
 * page can pass it across the client boundary. Columns and their cell/sort
 * functions live here, on the client side, where functions may.
 */
export type PaymentRunRow = {
  id: number
  paymentDate: string
  reference: string | null
  userName: string
  supplierCount: number
  totalAmount: number
  status: RunStatus
}

const STATUS_TONE: Record<RunStatus, 'warning' | 'success' | 'neutral'> = {
  draft: 'warning',
  posted: 'success',
  cancelled: 'neutral',
}

const STATUS_LABEL: Record<RunStatus, string> = {
  draft: 'Draft',
  posted: 'Posted',
  cancelled: 'Cancelled',
}

const RUN_COLUMNS: readonly Column<PaymentRunRow>[] = [
  {
    key: 'date',
    header: 'Payment date',
    sortable: true,
    sortValue: (run) => run.paymentDate,
    cell: (run) => (
      <Link href={`/suppliers/remittances/${run.id}`} className="text-brand hover:underline">
        {run.paymentDate}
      </Link>
    ),
  },
  {
    key: 'reference',
    header: 'Reference',
    sortable: true,
    sortValue: (run) => run.reference ?? '',
    cell: (run) => run.reference ?? '—',
  },
  {
    key: 'preparedBy',
    header: 'Prepared by',
    sortable: true,
    sortValue: (run) => run.userName ?? '',
    cell: (run) => run.userName || '—',
  },
  {
    key: 'suppliers',
    header: 'Suppliers',
    numeric: true,
    sortable: true,
    sortValue: (run) => run.supplierCount,
    cell: (run) => run.supplierCount,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    sortable: true,
    sortValue: (run) => run.totalAmount,
    cell: (run) => <span className="text-ink">{formatMoney(run.totalAmount)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    sortValue: (run) => run.status,
    cell: (run) => <Badge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>,
  },
]

export default function RunsTable({ runs }: { runs: PaymentRunRow[] }) {
  return (
    <DataTable
      columns={RUN_COLUMNS}
      rows={runs}
      getRowKey={(run) => run.id}
      empty={{
        title: 'No payment runs yet',
        hint: 'Choose what to pay above and prepare the first one.',
        icon: <Icons.Wallet size={28} strokeWidth={1.75} />,
      }}
    />
  )
}

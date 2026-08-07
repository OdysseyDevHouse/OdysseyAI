'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { StockTransfer, TransferStatus } from '@/lib/site/stockTransfers'

const STATUS_TONE: Record<TransferStatus, 'success' | 'neutral' | 'danger'> = {
  posted: 'success',
  draft: 'neutral',
  cancelled: 'danger',
}

const STATUS_LABEL: Record<TransferStatus, string> = {
  posted: 'Posted',
  draft: 'Draft',
  cancelled: 'Cancelled',
}

/**
 * The transfer list.
 *
 * Six columns, not ten: number, date, route, what moved, who, state. Anything
 * else — the lines, the reference, the void reason — lives on the transfer's
 * own screen, which is one click away. A list is for finding the row, not for
 * reading it.
 */
export default function TransfersTable({ transfers }: { transfers: StockTransfer[] }) {
  const router = useRouter()

  const columns: Column<StockTransfer>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (t) => <span className="text-ink">{t.documentNumber ?? '—'}</span>,
      sortValue: (t) => t.documentNumber ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (t) => t.documentDate,
      sortValue: (t) => t.documentDate,
    },
    {
      key: 'route',
      header: 'Moved',
      // The route IS the transfer — reading it left to right is the fastest
      // way to answer "where did that stock go".
      cell: (t) => (
        <span className="flex items-center gap-1.5">
          <span className="text-ink-2">{t.fromLocationCode}</span>
          <Icons.ArrowLeftRight size={13} className="text-faint" />
          <span className="text-ink">{t.toLocationCode}</span>
        </span>
      ),
      sortValue: (t) => `${t.fromLocationCode}→${t.toLocationCode}`,
    },
    {
      key: 'lines',
      header: 'Lines',
      numeric: true,
      cell: (t) => t.lineCount,
      sortValue: (t) => t.lineCount,
    },
    {
      key: 'qty',
      header: 'Units',
      numeric: true,
      cell: (t) => formatQty(t.totalQty),
      sortValue: (t) => t.totalQty,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>,
      sortValue: (t) => t.status,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={transfers}
      getRowKey={(t) => t.id}
      onRowClick={(t) => router.push(`/transfers/${t.id}`)}
      empty={{
        title: 'No transfers yet',
        hint: 'A transfer moves stock from one location to another without changing what the business owns in total.',
        icon: <Icons.ArrowLeftRight size={22} />,
      }}
    />
  )
}

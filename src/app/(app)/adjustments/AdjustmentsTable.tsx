'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { StockAdjustment, AdjustmentStatus } from '@/lib/site/stockAdjustments'

const STATUS_TONE: Record<AdjustmentStatus, 'success' | 'neutral' | 'danger'> = {
  posted: 'success',
  draft: 'neutral',
  cancelled: 'danger',
}

const STATUS_LABEL: Record<AdjustmentStatus, string> = {
  posted: 'Posted',
  draft: 'Draft',
  cancelled: 'Cancelled',
}

/**
 * The adjustment list.
 *
 * The two columns that earn their place over a transfer list are the REASON and
 * the VALUE. "How much did we lose to breakage" is the question this document
 * exists to answer, and both halves of it should be readable without opening a
 * single row.
 *
 * A draft shows no value because it has none yet: nothing has moved, and the
 * figure is only computed at post.
 */
export default function AdjustmentsTable({
  adjustments,
}: {
  adjustments: StockAdjustment[]
}) {
  const router = useRouter()

  const columns: Column<StockAdjustment>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (a) => <span className="text-ink">{a.documentNumber ?? 'Draft'}</span>,
      sortValue: (a) => a.documentNumber ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (a) => a.documentDate,
      sortValue: (a) => a.documentDate,
    },
    {
      key: 'location',
      header: 'Location',
      cell: (a) => <span className="text-ink-2">{a.locationCode}</span>,
      sortValue: (a) => a.locationCode,
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (a) =>
        a.reasonName ? (
          <span className="text-ink-2">{a.reasonName}</span>
        ) : (
          // Mixed means the lines carry their own reasons, which is a real and
          // useful answer rather than a missing one.
          <span className="text-faint">Mixed</span>
        ),
      sortValue: (a) => a.reasonName ?? '',
    },
    {
      key: 'lines',
      header: 'Lines',
      numeric: true,
      cell: (a) => a.lineCount,
      sortValue: (a) => a.lineCount,
    },
    {
      key: 'qty',
      header: 'Units',
      numeric: true,
      // Signed on purpose: the sign IS the information. A bare 12 cannot say
      // whether stock was found or lost.
      cell: (a) =>
        a.status === 'posted' ? (
          <span className={a.varianceQty < 0 ? 'text-danger-ink' : 'text-ink-2'}>
            {a.varianceQty > 0 ? '+' : ''}
            {formatQty(a.varianceQty)}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (a) => a.varianceQty,
    },
    {
      key: 'value',
      header: 'Value',
      numeric: true,
      cell: (a) =>
        a.status === 'posted' ? (
          <span className={a.varianceValue < 0 ? 'text-danger-ink' : 'text-ink-2'}>
            {formatMoney(a.varianceValue)}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (a) => a.varianceValue,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (a) => <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>,
      sortValue: (a) => a.status,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={adjustments}
      getRowKey={(a) => a.id}
      onRowClick={(a) => router.push(`/adjustments/${a.id}`)}
      empty={{
        title: 'No adjustments yet',
        hint: 'An adjustment writes stock on or off with a reason — damage, shrinkage, or a correction — without counting the whole location.',
        icon: <Icons.SlidersHorizontal size={22} />,
      }}
    />
  )
}

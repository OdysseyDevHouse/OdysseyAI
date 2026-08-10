'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { StockTake, StockTakeStatus } from '@/lib/site/stockTakes'

const STATUS_TONE: Record<StockTakeStatus, 'success' | 'neutral' | 'warning' | 'danger'> = {
  posted: 'success',
  draft: 'neutral',
  counting: 'warning',
  cancelled: 'danger',
}

const STATUS_LABEL: Record<StockTakeStatus, string> = {
  posted: 'Posted',
  draft: 'Draft',
  counting: 'Counting',
  cancelled: 'Cancelled',
}

/**
 * The stock take list.
 *
 * Six columns: number, date, where, progress, what it found, state. The lines
 * live on the sheet's own screen — a list is for finding the row, not reading it.
 *
 * Progress is the column that earns its place on a sheet still being counted,
 * because "how much is left" is the question someone opens this screen to ask.
 */
export default function StockTakesTable({ takes }: { takes: StockTake[] }) {
  const router = useRouter()

  const columns: Column<StockTake>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (t) => (
        <span className="text-ink">{t.documentNumber ?? <span className="text-faint">Draft</span>}</span>
      ),
      sortValue: (t) => t.documentNumber ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (t) => t.documentDate,
      sortValue: (t) => t.documentDate,
    },
    {
      key: 'location',
      header: 'Location',
      cell: (t) => <span className="text-ink-2">{t.locationName}</span>,
      sortValue: (t) => t.locationName,
    },
    {
      key: 'progress',
      header: 'Counted',
      numeric: true,
      // A posted sheet has counted everything by definition, so the fraction is
      // noise there; only a live count needs the running figure.
      cell: (t) =>
        t.status === 'posted' || t.status === 'cancelled' ? (
          <span className="text-muted">{t.lineCount}</span>
        ) : (
          <span className={t.countedCount === t.lineCount ? 'text-success' : 'text-ink-2'}>
            {t.countedCount} / {t.lineCount}
          </span>
        ),
      sortValue: (t) => (t.lineCount === 0 ? 0 : t.countedCount / t.lineCount),
    },
    {
      key: 'variance',
      header: 'Variance',
      numeric: true,
      /*
       * VALUE, not units, and the two genuinely disagree.
       *
       * A real posted sheet here came out at +38 units and -R30.40: forty cheap
       * units found, two expensive ones missing. Showing the unit figure put a
       * green +38 against a sheet that had written money OFF, which is the
       * wrong answer to the question this column exists for. Money is what a
       * shrinkage figure means, so money is what it shows — with the unit count
       * underneath for anyone who wants it.
       */
      cell: (t) => {
        if (t.status !== 'posted') return <span className="text-faint">—</span>
        if (Math.abs(t.varianceValue) < 0.005 && Math.abs(t.varianceQty) < 0.0005) {
          return <span className="text-muted">0</span>
        }
        return (
          <span className="inline-flex flex-col items-end leading-tight">
            <span className={t.varianceValue < 0 ? 'text-danger' : 'text-success'}>
              {t.varianceValue > 0 ? '+' : '−'}R{' '}
              {Math.abs(t.varianceValue).toLocaleString('en-ZA', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="text-xs text-muted">
              {t.varianceQty > 0 ? '+' : ''}
              {formatQty(t.varianceQty)} units
            </span>
          </span>
        )
      },
      sortValue: (t) => t.varianceValue,
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
      rows={takes}
      getRowKey={(t) => t.id}
      onRowClick={(t) => router.push(`/stock-takes/${t.id}`)}
      empty={{
        title: 'No stock takes yet',
        hint: 'A stock take records what is actually on the shelf and writes the difference, so shrinkage becomes a number you can act on rather than a surprise.',
        icon: <Icons.ClipboardList size={22} />,
      }}
    />
  )
}

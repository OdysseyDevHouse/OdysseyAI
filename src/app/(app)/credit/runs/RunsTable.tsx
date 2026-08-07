'use client'

import Link from 'next/link'
import { Badge, DataTable, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

/**
 * The runs register table.
 *
 * A client component because DataTable is one, and a Column carries `cell` and
 * `sortValue` — functions, which cannot cross the server/client boundary.
 * Defining them on the page fails the render outright with no useful error.
 * See PositionsTable for the longer note.
 */

export type RunRow = {
  id: number
  asAt: string
  status: 'draft' | 'sending' | 'completed' | 'cancelled'
  sentCount: number
  failedCount: number
  skippedCount: number
  totalOverdue: number
  userName: string
  sentByName: string | null
}

const STATUS_LABEL: Record<RunRow['status'], string> = {
  draft: 'Awaiting review',
  sending: 'Sending',
  completed: 'Sent',
  cancelled: 'Cancelled',
}

export function RunsTable({ rows }: { rows: RunRow[] }) {
  const columns: Column<RunRow>[] = [
    {
      key: 'run',
      header: 'Run',
      cell: (r) => (
        <Link href={`/credit/runs/${r.id}`} className="block hover:text-brand">
          <span className="text-ink">#{r.id}</span>
          <span className="mt-0.5 block text-xs text-muted">as at {r.asAt}</span>
        </Link>
      ),
      sortValue: (r) => r.id,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge
          tone={
            r.status === 'completed'
              ? 'success'
              : r.status === 'draft'
                ? 'brand'
                : r.status === 'sending'
                  ? 'warning'
                  : 'default'
          }
        >
          {STATUS_LABEL[r.status]}
        </Badge>
      ),
      sortValue: (r) => r.status,
    },
    {
      key: 'sent',
      header: 'Sent',
      numeric: true,
      cell: (r) => (
        <>
          <span className="text-ink">{r.status === 'draft' ? '—' : r.sentCount}</span>
          {r.failedCount > 0 && (
            <span className="mt-0.5 block text-xs text-danger">{r.failedCount} failed</span>
          )}
        </>
      ),
      sortValue: (r) => r.sentCount,
    },
    {
      key: 'skipped',
      header: 'Not chased',
      numeric: true,
      cell: (r) => <span className="text-muted">{r.skippedCount}</span>,
      sortValue: (r) => r.skippedCount,
    },
    {
      key: 'value',
      header: 'Chased',
      numeric: true,
      cell: (r) => <span className="text-ink">{formatMoney(r.totalOverdue)}</span>,
      sortValue: (r) => r.totalOverdue,
    },
    {
      key: 'who',
      header: 'Released by',
      cell: (r) => (
        <>
          <span className="text-ink-2">{r.sentByName ?? '—'}</span>
          <span className="mt-0.5 block text-xs text-muted">built by {r.userName}</span>
        </>
      ),
      sortValue: (r) => r.sentByName ?? '',
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{ title: 'No runs', hint: '' }}
    />
  )
}

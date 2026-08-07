'use client'

import { Badge, DataTable, Icons, TextLink, type Column } from '@/components/ui'
import type { RunStatus } from '@/lib/site/statementRuns'

/**
 * The recent-runs list. A client component only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down pre-formatted, serialisable rows.
 */

export type RunRow = {
  id: number
  period: string
  formatLabel: string
  started: string | null
  /** Epoch millis, so "Started" sorts by time rather than by formatted text. */
  startedSort: number
  by: string
  sent: number
  failed: number
  skipped: number
  status: RunStatus
  error: string | null
}

const STATUS_TONE: Record<RunStatus, 'neutral' | 'brand' | 'success' | 'danger'> = {
  pending: 'neutral',
  running: 'brand',
  completed: 'success',
  failed: 'danger',
}

const STATUS_LABELS: Record<RunStatus, string> = {
  pending: 'Pending',
  running: 'Sending',
  completed: 'Completed',
  failed: 'Failed',
}

/* One treatment for every count: plain tabular figures, zeros greyed so the
   eye lands on the money. Only a genuine failure earns a badge. */
function count(value: number) {
  return value === 0 ? <span className="text-faint">0</span> : value
}

const COLUMNS: readonly Column<RunRow>[] = [
  {
    key: 'period',
    header: 'Period',
    sortable: true,
    sortValue: (row) => row.period,
    cell: (row) => (
      <div>
        <TextLink href={`/customers/statements/${row.id}`}>{row.period}</TextLink>
        <div className="text-xs text-muted">{row.formatLabel}</div>
      </div>
    ),
  },
  {
    key: 'started',
    header: 'Started',
    sortable: true,
    sortValue: (row) => row.startedSort,
    cell: (row) => row.started ?? '—',
  },
  { key: 'by', header: 'By', sortable: true, cell: (row) => row.by || '—' },
  {
    key: 'sent',
    header: 'Sent',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.sent,
    cell: (row) => count(row.sent),
  },
  {
    key: 'failed',
    header: 'Failed',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.failed,
    cell: (row) => (row.failed > 0 ? <Badge tone="danger">{row.failed}</Badge> : count(0)),
  },
  {
    key: 'skipped',
    header: 'Skipped',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.skipped,
    cell: (row) => count(row.skipped),
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    sortValue: (row) => STATUS_LABELS[row.status],
    cell: (row) => (
      <span title={row.error ?? undefined}>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
      </span>
    ),
  },
]

export default function RecentRunsTable({
  runs,
  emptyHint,
}: {
  runs: RunRow[]
  /** Points at the Send card above — where the first run comes from. */
  emptyHint: string
}) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={runs}
      getRowKey={(row) => row.id}
      empty={{ title: 'No statement runs yet', hint: emptyHint, icon: <Icons.Mail size={22} /> }}
    />
  )
}

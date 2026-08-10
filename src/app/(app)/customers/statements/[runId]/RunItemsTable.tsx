'use client'

import { Badge, DataTable, Icons, TextLink, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { ItemStatus } from '@/lib/site/statementRuns'

/**
 * Per-account outcomes of one statement run. A client component only because
 * DataTable's column cells are functions, which a Server Component cannot
 * pass across the boundary — the page hands down serialisable rows.
 */

export type RunItemRow = {
  id: number
  customerId: number
  code: string
  name: string
  email: string | null
  /** What this account was statemented for — it varies per row on a cycle run. */
  period: string
  balance: number
  overdue: number
  when: string | null
  /** Epoch millis, so "When" sorts by time rather than by formatted text. */
  whenSort: number
  status: ItemStatus
  error: string | null
}

const ITEM_TONE: Record<ItemStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
}

const ITEM_LABELS: Record<ItemStatus, string> = {
  queued: 'Queued',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
}

const COLUMNS: readonly Column<RunItemRow>[] = [
  {
    key: 'account',
    header: 'Account',
    sortable: true,
    sortValue: (row) => row.code,
    cell: (row) => (
      <div>
        <TextLink href={`/customers/${row.customerId}`}>{row.code}</TextLink>
        <div className="text-ink">{row.name}</div>
      </div>
    ),
  },
  {
    key: 'email',
    header: 'Sent to',
    sortable: true,
    sortValue: (row) => row.email ?? '',
    cell: (row) => row.email ?? <span className="text-faint">—</span>,
  },
  {
    // Its own column because it varies per row: each account is statemented for
    // its own cycle period, so the run header cannot speak for all of them.
    key: 'period',
    header: 'Period',
    sortable: true,
    sortValue: (row) => row.period,
    cell: (row) => <span className="text-ink-2">{row.period}</span>,
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    cell: (row) => formatMoney(row.balance),
  },
  {
    key: 'overdue',
    header: 'Overdue',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.overdue,
    cell: (row) =>
      row.overdue > 0 ? (
        <span className="text-danger">{formatMoney(row.overdue)}</span>
      ) : (
        <span className="text-faint">—</span>
      ),
  },
  {
    key: 'when',
    header: 'When',
    sortable: true,
    sortValue: (row) => row.whenSort,
    cell: (row) => row.when ?? '—',
  },
  {
    key: 'outcome',
    header: 'Outcome',
    sortable: true,
    sortValue: (row) => ITEM_LABELS[row.status],
    cell: (row) => (
      <div>
        <span title={row.error ?? undefined}>
          <Badge tone={ITEM_TONE[row.status]}>{ITEM_LABELS[row.status]}</Badge>
        </span>
        {row.error && <div className="mt-0.5 max-w-xs truncate text-xs text-muted">{row.error}</div>}
      </div>
    ),
  },
]

export default function RunItemsTable({ items }: { items: RunItemRow[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={items}
      getRowKey={(row) => row.id}
      empty={{
        title: 'No accounts in this run',
        hint: 'Every account that was queued appears here with its outcome.',
        icon: <Icons.Mail size={22} />,
      }}
    />
  )
}

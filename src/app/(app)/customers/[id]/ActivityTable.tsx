'use client'

import { Badge, DataTable, Icons, type Column } from '@/components/ui'

/**
 * The activity tab's table. A client component only because DataTable's
 * column cells are functions, which a Server Component cannot pass across the
 * boundary — the page pre-formats each event into plain strings.
 */

export type ActivityRow = {
  id: number
  when: string
  /** Epoch millis, so "When" sorts by time rather than by formatted text. */
  whenSort: number
  who: string
  action: string
  detail: string | null
}

const COLUMNS: readonly Column<ActivityRow>[] = [
  {
    key: 'when',
    header: 'When',
    sortable: true,
    sortValue: (row) => row.whenSort,
    width: 'w-44',
    cell: (row) => <span className="whitespace-nowrap text-ink-2">{row.when}</span>,
  },
  { key: 'who', header: 'Who', sortable: true, cell: (row) => row.who },
  {
    key: 'action',
    header: 'Action',
    sortable: true,
    sortValue: (row) => row.action,
    // A badge only for the genuine exception — a status change is the entry
    // someone scans this log for; routine edits stay plain and muted.
    cell: (row) =>
      row.action === 'status' ? (
        <Badge tone="warning">Status</Badge>
      ) : (
        <span className="text-muted">{row.action}</span>
      ),
  },
  { key: 'detail', header: 'Detail', cell: (row) => row.detail ?? '—' },
]

export default function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={{
        title: 'Nothing recorded yet',
        hint: 'Edits, status changes and statements sent will appear here.',
        icon: <Icons.History size={22} />,
      }}
    />
  )
}

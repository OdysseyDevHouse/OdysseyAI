'use client'

import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, type Column } from '@/components/ui'

/**
 * The previous-runs table, as a client component.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns are functions, which cannot cross the server→client boundary. The
 * page maps the runs into plain rows (dates already formatted); the columns
 * live here.
 */

export type RunRow = {
  id: number
  periodFrom: string
  periodTo: string
  asAtDate: string
  userName: string
  status: string
  /** Posting date as YYYY-MM-DD, computed server-side from the timestamp. */
  postedAtDate: string | null
  postedCount: number
  totalAmount: number
}

export function RunsTable({ rows }: { rows: RunRow[] }) {
  const columns: Column<RunRow>[] = [
    {
      key: 'period',
      header: 'Period',
      cell: (r) => (
        <>
          <span className="text-ink">
            {r.periodFrom} → {r.periodTo}
          </span>
          <span className="mt-0.5 block text-xs text-muted">
            as at {r.asAtDate} · {r.userName}
          </span>
        </>
      ),
      sortValue: (r) => r.periodFrom,
    },
    {
      key: 'posted',
      header: 'Posted',
      cell: (r) =>
        r.status === 'posted' ? (
          <span className="text-ink-2">{r.postedAtDate ?? '—'}</span>
        ) : (
          <Badge tone="default">Cancelled</Badge>
        ),
      sortValue: (r) => r.postedAtDate ?? '',
    },
    {
      key: 'accounts',
      header: 'Accounts',
      numeric: true,
      cell: (r) => (r.status === 'posted' ? r.postedCount : <span className="text-faint">—</span>),
      sortValue: (r) => r.postedCount,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (r) => formatMoney(r.totalAmount),
      sortValue: (r) => r.totalAmount,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        title: 'No interest has been charged',
        hint: 'Interest is off on every account until it is switched on individually — charging it needs a written agreement with the customer.',
      }}
    />
  )
}

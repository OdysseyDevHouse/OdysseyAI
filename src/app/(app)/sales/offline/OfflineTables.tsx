'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, EmptyState, Icons, type Column } from '@/components/ui'

/**
 * The three offline lists. Client components only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the boundary —
 * the page hands down pre-formatted, serialisable rows.
 */

export type ExceptionRow = {
  documentId: number
  documentNumber: string | null
  status: string
  documentDate: string
  /** Pre-formatted on the server: a Date across the boundary is a hydration risk. */
  takenAtLabel: string | null
  terminalCode: string | null
  userName: string
  customerName: string | null
  totalIncl: number
  exception: string
}

export type StuckRow = {
  saleUid: string
  status: string
  documentNumber: string | null
  operatorName: string
  error: string | null
  attempts: number
  claimedAtLabel: string | null
  /** False when the sale this claim named is no longer a document anywhere. */
  hasDocument: boolean
}

/* ── Posted, but something disagreed ─────────────────────────────────────── */

const EXCEPTION_COLUMNS: readonly Column<ExceptionRow>[] = [
  {
    key: 'number',
    header: 'Invoice',
    sortable: true,
    cell: (row) => (
      <Link href={`/sales/${row.documentId}`} className="text-brand hover:underline">
        {row.documentNumber ?? `#${row.documentId}`}
      </Link>
    ),
    sortValue: (row) => row.documentNumber ?? `#${row.documentId}`,
  },
  {
    key: 'takenAt',
    header: 'Rung up',
    sortable: true,
    cell: (row) => row.takenAtLabel ?? <span className="text-faint">—</span>,
    sortValue: (row) => row.takenAtLabel ?? '',
  },
  {
    key: 'till',
    header: 'Till',
    cell: (row) => row.terminalCode ?? <span className="text-faint">—</span>,
  },
  { key: 'operator', header: 'Cashier', sortable: true, cell: (row) => row.userName },
  {
    key: 'customer',
    header: 'Customer',
    cell: (row) => row.customerName ?? <span className="text-faint">Walk-in</span>,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    sortable: true,
    cell: (row) => formatMoney(row.totalIncl),
    sortValue: (row) => row.totalIncl,
  },
  {
    /* The whole reason this screen exists, so it gets the width rather than a
       truncated cell with a tooltip nobody hovers on a counter screen. */
    key: 'why',
    header: 'What disagreed',
    cell: (row) => <span className="text-sm text-muted">{row.exception}</span>,
  },
]

export function ExceptionsTable({ rows }: { rows: readonly ExceptionRow[] }) {
  return (
    <DataTable
      rows={rows}
      columns={EXCEPTION_COLUMNS}
      getRowKey={(row) => row.documentId}
      empty={{
        icon: <Icons.Check size={22} />,
        title: 'Nothing to review',
        hint: 'Every sale rung up offline priced exactly as the server would have priced it.',
      }}
    />
  )
}

/* ── Not posted — money in a drawer, absent from the books ────────────────── */

const QUARANTINE_COLUMNS: readonly Column<ExceptionRow>[] = [
  {
    key: 'number',
    header: 'Printed as',
    cell: (row) => (
      <Link href={`/sales/${row.documentId}`} className="text-brand hover:underline">
        {row.documentNumber ?? `#${row.documentId}`}
      </Link>
    ),
  },
  { key: 'date', header: 'Dated', cell: (row) => row.documentDate },
  {
    key: 'takenAt',
    header: 'Rung up',
    cell: (row) => row.takenAtLabel ?? <span className="text-faint">—</span>,
  },
  {
    key: 'till',
    header: 'Till',
    cell: (row) => row.terminalCode ?? <span className="text-faint">—</span>,
  },
  { key: 'operator', header: 'Cashier', cell: (row) => row.userName },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    cell: (row) => <span className="font-medium">{formatMoney(row.totalIncl)}</span>,
  },
  {
    key: 'why',
    header: 'Why it could not post',
    cell: (row) => <span className="text-sm text-muted">{row.exception}</span>,
  },
]

export function QuarantineTable({ rows }: { rows: readonly ExceptionRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Check size={22} />}
        title="Nothing quarantined"
        hint="Every offline sale that has come in is on the books."
      />
    )
  }
  return (
    <DataTable rows={rows} columns={QUARANTINE_COLUMNS} getRowKey={(row) => row.documentId} />
  )
}

/* ── Claimed but never posted — a plumbing problem, not a judgement call ──── */

const STUCK_COLUMNS: readonly Column<StuckRow>[] = [
  {
    key: 'uid',
    header: 'Sale',
    // The uid is 36 characters of hex and nobody reads it whole; the last block
    // is enough to match a row against a till's own outbox screen.
    cell: (row) => <span className="font-mono text-xs">…{row.saleUid.slice(-12)}</span>,
  },
  {
    key: 'number',
    header: 'Number',
    cell: (row) => row.documentNumber ?? <span className="text-faint">not issued</span>,
  },
  { key: 'operator', header: 'Cashier', cell: (row) => row.operatorName || '—' },
  {
    key: 'status',
    header: 'State',
    cell: (row) => {
      /* A claim whose document is gone has nothing left to act on. Saying
         "Refused" would send somebody looking for a sale that is not there. */
      if (!row.hasDocument) return <Badge tone="neutral">No document</Badge>
      return (
        <Badge tone={row.status === 'rejected' ? 'danger' : 'warning'}>
          {row.status === 'rejected' ? 'Refused' : 'Still trying'}
        </Badge>
      )
    },
  },
  { key: 'attempts', header: 'Tries', numeric: true, cell: (row) => String(row.attempts) },
  {
    key: 'claimed',
    header: 'First seen',
    cell: (row) => row.claimedAtLabel ?? <span className="text-faint">—</span>,
  },
  {
    key: 'error',
    header: 'Last error',
    cell: (row) =>
      row.error ? (
        <span className="text-sm text-muted">{row.error}</span>
      ) : (
        <span className="text-faint">—</span>
      ),
  },
]

export function StuckTable({ rows }: { rows: readonly StuckRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Check size={22} />}
        title="Nothing stuck"
        hint="Every sale a till has claimed has finished posting."
      />
    )
  }
  return <DataTable rows={rows} columns={STUCK_COLUMNS} getRowKey={(row) => row.saleUid} />
}

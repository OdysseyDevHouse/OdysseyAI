'use client'

import Link from 'next/link'
import { Badge, DataTable, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { DocType } from '@/lib/site/ledger'

/**
 * The ledger table — debit, credit, outstanding, running balance.
 *
 * One implementation for both sub-ledgers. A ledger line is a ledger line
 * whichever way the money flows: only the column headings would differ, and
 * they do not differ enough to justify a second copy.
 *
 * Debit and credit are shown as SEPARATE columns rather than one signed figure,
 * because that is how a statement reads and how anyone checking one expects to
 * scan it. The sign lives in the data; the columns are the presentation.
 */

export type LedgerRow = {
  id: number
  docType: DocType
  docLabel: string
  docNumber: string | null
  docDate: string
  dueDate: string | null
  reference: string | null
  description: string | null
  amountSigned: number
  amountOutstanding: number
  runningBalance?: number
  daysOverdue?: number
  /**
   * The sale that produced this entry, when one did.
   *
   * An account sale posts a ledger line, and "what was actually on that
   * invoice" is the first thing anyone asks when querying it. Without the link
   * the answer means cross-referencing a document number by hand.
   */
  sourceDocId?: number | null
  source?: string
}

export function TransactionTable({
  rows,
  actions,
  onRowClick,
}: {
  rows: readonly LedgerRow[]
  actions?: (row: LedgerRow) => React.ReactNode
  onRowClick?: (row: LedgerRow) => void
}) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(row) => row.id}
      actions={actions}
      onRowClick={onRowClick}
      empty={{
        title: 'No transactions yet',
        hint: 'Invoices, payments and adjustments will appear here.',
      }}
    />
  )
}

const COLUMNS: readonly Column<LedgerRow>[] = [
  {
    key: 'docDate',
    header: 'Date',
    sortable: true,
    // ISO strings sort correctly as text, which is why the date columns are
    // kept as strings rather than parsed into Date objects.
    cell: (row) => row.docDate,
  },
  {
    key: 'docType',
    header: 'Type',
    sortable: true,
    sortValue: (row) => row.docLabel,
    cell: (row) => (
      <div>
        <div className="text-ink">{row.docLabel}</div>
        {row.docNumber &&
          (row.source === 'sale' && row.sourceDocId ? (
            // Straight through to the sale itself, so "what was on that
            // invoice" is one click rather than a manual search.
            <Link
              href={`/sales/${row.sourceDocId}`}
              className="text-xs text-brand hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.docNumber}
            </Link>
          ) : (
            <div className="text-xs text-muted">{row.docNumber}</div>
          ))}
      </div>
    ),
  },
  {
    key: 'description',
    header: 'Description',
    cell: (row) => (
      <div>
        <div className="text-ink-2">{row.description ?? '—'}</div>
        {row.reference && <div className="text-xs text-muted">Ref: {row.reference}</div>}
      </div>
    ),
  },
  {
    key: 'due',
    header: 'Due',
    sortable: true,
    sortValue: (row) => row.dueDate ?? '',
    cell: (row) => {
      if (!row.dueDate) return <span className="text-faint">—</span>
      const overdue = (row.daysOverdue ?? 0) > 0
      return (
        <div>
          <div className={overdue ? 'text-danger' : 'text-ink-2'}>{row.dueDate}</div>
          {overdue && (
            <div className="text-xs text-danger">{row.daysOverdue} day{row.daysOverdue === 1 ? '' : 's'} late</div>
          )}
        </div>
      )
    },
  },
  {
    key: 'debit',
    header: 'Debit',
    numeric: true,
    sortable: true,
    sortValue: (row) => (row.amountSigned > 0 ? row.amountSigned : 0),
    cell: (row) => (row.amountSigned > 0 ? formatMoney(row.amountSigned) : ''),
  },
  {
    key: 'credit',
    header: 'Credit',
    numeric: true,
    sortable: true,
    sortValue: (row) => (row.amountSigned < 0 ? -row.amountSigned : 0),
    // Shown unsigned in its own column: the column IS the sign.
    cell: (row) => (row.amountSigned < 0 ? formatMoney(-row.amountSigned) : ''),
  },
  {
    key: 'outstanding',
    header: 'Outstanding',
    numeric: true,
    sortable: true,
    sortValue: (row) => Math.abs(row.amountOutstanding),
    cell: (row) => <OutstandingCell row={row} />,
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    cell: (row) =>
      row.runningBalance === undefined ? '' : (
        <span className="text-ink">{formatMoney(row.runningBalance)}</span>
      ),
  },
]

/**
 * How much of this line is still unmatched.
 *
 * A settled line shows a quiet badge rather than "0.00" — the useful signal is
 * "this one is done", and a column of zeroes reads as noise. A partly-settled
 * debit shows what is left, which is the figure a collections call quotes.
 */
function OutstandingCell({ row }: { row: LedgerRow }) {
  if (row.amountOutstanding === 0) {
    return <Badge tone="neutral">Settled</Badge>
  }

  const overdue = (row.daysOverdue ?? 0) > 0
  const partly = Math.abs(row.amountOutstanding) < Math.abs(row.amountSigned)

  return (
    <span className={overdue ? 'text-danger' : 'text-ink'}>
      {formatMoney(Math.abs(row.amountOutstanding))}
      {partly && <span className="ml-1 text-xs text-muted">part</span>}
    </span>
  )
}

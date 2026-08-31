'use client'

import Link from 'next/link'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import PayButton from './invoices/PayButton'
import { DOC_LABEL } from './documents'

/**
 * The ledger, as a table — shared by Transactions and Statement.
 *
 * ── WHY THIS IS A CLIENT COMPONENT ─────────────────────────────────────────
 *
 * DataTable is `'use client'`, and a Column array is a list of FUNCTIONS. A
 * server component that builds one and passes it across the boundary cannot
 * serialise the cell renderers, and the page throws at request time while both
 * `tsc` and the build stay green. So the columns are defined on this side and
 * the server hands over plain data.
 *
 * ── ONE TABLE, TWO PAGES ───────────────────────────────────────────────────
 *
 * Transactions and Statement show the same rows with the same columns and
 * differ only in which lines they are given and whether a Pay button is
 * offered. Written twice they would drift — one would grow a receipt link the
 * other lacked — which is the same reasoning as `documentHref`.
 */

export type LedgerRow = {
  transactionId: number
  docType: string
  docNumber: string
  docDate: string
  dueDate: string | null
  amountSigned: number
  amountOutstanding: number
  runningBalance: number
  /** Where the PDF for this line lives, or null when it has no paper. */
  href: string | null
  /** The sales document behind an invoice, for the Pay button. */
  sourceDocId: number | null
}

export default function LedgerTable({
  rows,
  token,
  /** Show the running balance — the activity view wants it, a statement does not. */
  showBalance = false,
  allowPay = false,
  emptyTitle,
  emptyHint,
}: {
  rows: LedgerRow[]
  token: string
  showBalance?: boolean
  allowPay?: boolean
  emptyTitle: string
  emptyHint: string
}) {
  /*
   * Computed here rather than passed in: a date is not serialisable across the
   * server boundary as a Date, and threading a string prop through two pages
   * for one comparison is more surface than the comparison is worth. Local
   * midnight is the right frame — a customer reads "overdue" against their own
   * calendar, not UTC.
   */
  const today = new Date().toLocaleDateString('en-CA')

  /*
   * ── THE STATUS COLUMN ONLY APPEARS WHEN THE ROWS DISAGREE ────────────────
   *
   * A badge marks an exception. On a list filtered to open items where every
   * one is also past due, an "Overdue" chip on all eleven rows marks the rule —
   * the reader's eye is drawn eleven times and learns nothing, and the stat
   * tile above has already said "all 11 past the due date" in one line.
   *
   * So the column is dropped entirely when every row would say the same thing,
   * and the space goes to the columns that do differ. It comes back the moment
   * one row is settled, part-paid, or current while others are late — which is
   * exactly when a reader needs to tell them apart.
   */
  const statuses = new Set(
    rows.map((row) => {
      if (row.amountOutstanding <= 0.005) return 'settled'
      if (Math.abs(row.amountOutstanding - row.amountSigned) > 0.005) return 'part'
      return row.dueDate && row.dueDate < today ? 'overdue' : 'open'
    }),
  )
  const showStatus = statuses.size > 1
  const columns: Column<LedgerRow>[] = [
    {
      key: 'document',
      header: 'Document',
      // Identity first, as every list in this app does: the number, with what
      // kind of thing it is underneath rather than in a column of its own.
      cell: (row) => (
        <span className="block">
          <span className="numeric block font-medium text-ink">
            {row.docNumber || DOC_LABEL[row.docType] || row.docType}
          </span>
          <span className="block text-xs text-muted">
            {DOC_LABEL[row.docType] ?? row.docType}
          </span>
        </span>
      ),
      sortValue: (row) => row.docNumber,
    },
    {
      key: 'date',
      header: 'Date',
      cell: (row) => (
        <span className="block">
          <span className="numeric block text-ink-2">{row.docDate}</span>
          {row.dueDate && (
            <span className="numeric block text-xs text-muted">due {row.dueDate}</span>
          )}
        </span>
      ),
      sortValue: (row) => row.docDate,
    },
    ...(showStatus
      ? [
          {
            key: 'status',
            header: 'Status',
            /*
             * State gets a FORM, not just a value — but only where it is an
             * EXCEPTION. See `showStatus` above for why this whole column
             * disappears when every row would say the same thing.
             *
             *   overdue   — the one that means act, and the only danger here
             *   part-paid — where "what this was" and "what is left" disagree,
             *               so the amount column alone would mislead
             *   settled   — on a list that mixes settled and open lines
             *
             * A plain, current, open item gets nothing: on a page headed "what
             * you still owe", "open" is the premise, not news.
             */
            cell: (row: LedgerRow) => {
              if (row.amountOutstanding <= 0.005) {
                /*
                 * A CREDIT is not "settled" — a payment or a credit note is
                 * money coming the other way, and calling it settled invites
                 * the reader to wonder what was owed on it. The sign of the
                 * line is what separates the two.
                 */
                return row.amountSigned < 0 ? (
                  <Badge tone="success" dot>Received</Badge>
                ) : (
                  <Badge tone="success" dot>Settled</Badge>
                )
              }
              if (Math.abs(row.amountOutstanding - row.amountSigned) > 0.005) {
                return <Badge tone="warning" dot>{formatMoney(row.amountOutstanding)} left</Badge>
              }
              return row.dueDate && row.dueDate < today ? (
                <Badge tone="danger" dot>Overdue</Badge>
              ) : null
            },
            sortValue: (row: LedgerRow) => row.amountOutstanding,
          },
        ]
      : []),
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      // Signed, so a payment reads as a credit rather than as another charge.
      // The sign is the whole meaning on a debtors ledger.
      cell: (row) => (
        <span className={row.amountSigned < 0 ? 'text-success-ink' : 'text-ink'}>
          {row.amountSigned < 0 ? '−' : ''}
          {formatMoney(Math.abs(row.amountSigned))}
        </span>
      ),
      sortValue: (row) => row.amountSigned,
    },
    ...(showBalance
      ? [
          {
            key: 'balance',
            header: 'Balance',
            numeric: true,
            cell: (row: LedgerRow) => (
              <span className="text-muted">{formatMoney(row.runningBalance)}</span>
            ),
            sortValue: (row: LedgerRow) => row.runningBalance,
          },
        ]
      : []),
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.transactionId}
      empty={{ title: emptyTitle, hint: emptyHint, icon: <Icons.Receipt size={22} /> }}
      /*
       * Actions hard right, icon-first, exactly as a back-office list does.
       * The PDF is a Link rather than a Button because it navigates to a file —
       * a right-click "save as" should work.
       */
      actions={(row) => (
        <span className="flex items-center justify-end gap-2">
          {row.href && (
            <Link
              href={row.href}
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <Icons.Download size={13} />
              PDF
            </Link>
          )}
          {allowPay &&
            row.amountOutstanding > 0.005 &&
            row.docType === 'invoice' &&
            row.sourceDocId && <PayButton token={token} documentId={row.sourceDocId} />}
        </span>
      )}
    />
  )
}

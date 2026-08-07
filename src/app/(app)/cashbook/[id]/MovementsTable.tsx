'use client'

import { DataTable, Badge, ButtonLink, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { listTransactions } from '@/lib/site/cashbook'

/**
 * The recent-movements table. A client component only because DataTable's
 * column cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down plain, serialisable rows.
 */

type Movement = Awaited<ReturnType<typeof listTransactions>>[number]

const movementColumns: Column<Movement>[] = [
  {
    key: 'date',
    header: 'Date',
    cell: (t) => <span className="whitespace-nowrap">{t.txnDate}</span>,
    sortValue: (t) => t.txnDate,
  },
  {
    key: 'description',
    header: 'Description',
    cell: (t) => (
      <>
        <span
          className={`block truncate ${
            t.status === 'void' ? 'text-faint line-through' : 'text-ink'
          }`}
        >
          {t.description ?? t.reference ?? 'No description'}
        </span>
        {(t.reference || t.source !== 'manual') && (
          <span className="mt-0.5 block text-xs text-muted">
            {t.reference ?? ''}
            {t.reference && t.source !== 'manual' ? ' · ' : ''}
            {t.source !== 'manual' ? t.source : ''}
          </span>
        )}
      </>
    ),
    sortValue: (t) => t.description ?? t.reference ?? '',
  },
  {
    key: 'status',
    header: 'Status',
    cell: (t) =>
      t.status === 'reconciled' ? (
        <Badge tone="success">Reconciled</Badge>
      ) : t.status === 'void' ? (
        <Badge tone="default">Void</Badge>
      ) : (
        <span className="text-faint">—</span>
      ),
    sortValue: (t) => t.status,
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    cell: (t) => (
      <span className={t.status === 'void' ? 'text-faint line-through' : ''}>
        {formatMoney(t.amountSigned)}
      </span>
    ),
    sortValue: (t) => t.amountSigned,
  },
  {
    key: 'running',
    header: 'Running balance',
    numeric: true,
    // The figure this column exists for — it stays ink, not muted.
    cell: (t) => <span className="text-ink">{formatMoney(t.runningBalance ?? 0)}</span>,
    sortValue: (t) => t.runningBalance ?? 0,
  },
]

export function MovementsTable({ rows, accountId }: { rows: Movement[]; accountId: number }) {
  return (
    <DataTable
      columns={movementColumns}
      rows={rows}
      getRowKey={(t) => t.id}
      empty={{
        title: 'Nothing has moved through this account yet',
        hint: 'Import a bank statement to bring its lines in, or capture a movement from the reconcile card above.',
        action: (
          <ButtonLink href={`/cashbook/import?account=${accountId}`} variant="secondary" size="sm">
            <Icons.Upload size={15} />
            Import a statement
          </ButtonLink>
        ),
      }}
    />
  )
}

'use client'

import { DataTable, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { getExpense } from '@/lib/site/expenses'

/**
 * The expense-lines table. A client component only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down the plain line rows.
 */

type Expense = NonNullable<Awaited<ReturnType<typeof getExpense>>>
type LineRow = Expense['lines'][number]

const lineColumns: Column<LineRow>[] = [
  {
    key: 'category',
    header: 'Category',
    cell: (line) => (
      <>
        <span className="text-ink">{line.categoryName}</span>
        <span className="ml-2 text-xs text-muted">{line.categoryCode}</span>
      </>
    ),
    sortValue: (line) => line.categoryName ?? '',
  },
  {
    key: 'description',
    header: 'Description',
    cell: (line) => <span className="text-muted">{line.description ?? '—'}</span>,
    sortValue: (line) => line.description ?? '',
  },
  {
    key: 'department',
    header: 'Department',
    cell: (line) => <span className="text-muted">{line.departmentName ?? '—'}</span>,
    sortValue: (line) => line.departmentName ?? '',
  },
  {
    key: 'excl',
    header: 'Excl',
    numeric: true,
    cell: (line) => formatMoney(line.lineExcl),
    sortValue: (line) => line.lineExcl,
  },
  {
    key: 'vat',
    header: 'VAT',
    numeric: true,
    // Non-claimable VAT recedes rather than shouting — the totals panel
    // already states what the return may claim.
    cell: (line) =>
      line.lineVat === 0 ? (
        <span className="text-faint">—</span>
      ) : line.vatClaimable ? (
        formatMoney(line.lineVat)
      ) : (
        <span className="text-muted" title="Not claimable on the VAT return">
          {formatMoney(line.lineVat)}
        </span>
      ),
    sortValue: (line) => line.lineVat,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    cell: (line) => formatMoney(line.lineIncl),
    sortValue: (line) => line.lineIncl,
  },
]

export function ExpenseLinesTable({ rows }: { rows: LineRow[] }) {
  return <DataTable columns={lineColumns} rows={rows} getRowKey={(line) => line.id} />
}

'use client'

import Link from 'next/link'
import { DataTable, Badge, ButtonLink, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { listExpenses } from '@/lib/site/expenses'
import type { spendByCategory } from '@/lib/site/expenseReports'

/**
 * The expenses-list and spend-by-category tables. Client components only
 * because DataTable's column cells are functions, which a Server Component
 * cannot pass across the boundary — the page hands down plain rows.
 */

type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>['items'][number]
type CategoryRow = Awaited<ReturnType<typeof spendByCategory>>['rows'][number]

const columns: Column<ExpenseRow>[] = [
  // Identity first: who was paid is what a person scans this list for; the
  // document number rides along as the subline.
  {
    key: 'payee',
    header: 'Paid to',
    cell: (e) => (
      <Link href={`/expenses/${e.id}`} className="block hover:text-brand">
        <span className="font-medium text-ink">{e.supplierName ?? 'Not stated'}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {e.documentNumber ?? 'Draft'}
          {e.description ? ` · ${e.description}` : ''}
        </span>
      </Link>
    ),
    sortValue: (e) => e.supplierName ?? '',
  },
  {
    key: 'date',
    header: 'Date',
    cell: (e) => <span className="whitespace-nowrap">{e.expenseDate}</span>,
    sortValue: (e) => e.expenseDate,
  },
  {
    key: 'type',
    header: 'Type',
    // Neutral either way — Bill vs Paid is a category, not an exception.
    cell: (e) => (
      <Badge tone="default">{e.paymentType === 'on_account' ? 'Bill' : 'Paid'}</Badge>
    ),
    sortValue: (e) => e.paymentType,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (e) =>
      e.status === 'draft' ? (
        <Badge tone="warning">Draft</Badge>
      ) : e.status === 'void' ? (
        <Badge tone="default">Void</Badge>
      ) : (
        <Badge tone="success">Posted</Badge>
      ),
    sortValue: (e) => e.status,
  },
  {
    key: 'vat',
    header: 'VAT',
    numeric: true,
    // Non-claimable VAT is marked by receding, not by a note inside the
    // money column — the muted figure with a tooltip keeps the numbers clean.
    cell: (e) =>
      e.vatTotal === 0 ? (
        <span className="text-faint">—</span>
      ) : e.vatClaimable === 0 ? (
        <span className="text-muted" title="This VAT is not claimable">
          {formatMoney(e.vatTotal)}
        </span>
      ) : (
        <span className="text-ink-2">{formatMoney(e.vatTotal)}</span>
      ),
    sortValue: (e) => e.vatTotal,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    cell: (e) => (
      <span className={e.status === 'void' ? 'text-faint line-through' : 'text-ink'}>
        {formatMoney(e.totalIncl)}
      </span>
    ),
    sortValue: (e) => e.totalIncl,
  },
]

export function ExpensesTable({
  rows,
  searchQuery,
  status,
}: {
  rows: ExpenseRow[]
  /** The active search, so the empty state can name what found nothing. */
  searchQuery?: string
  /** The active status filter, so the empty state matches the slice shown. */
  status?: string
}) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(e) => e.id}
      empty={{
        title: searchQuery
          ? `Nothing matches "${searchQuery}"`
          : status === 'draft'
            ? 'No drafts waiting'
            : 'No expenses in this period',
        hint: searchQuery
          ? 'Try a different search, or widen the date range.'
          : 'Rent, fuel, insurance, subscriptions — everything the business spends that is not stock goes here.',
        action: !searchQuery ? (
          <ButtonLink href="/expenses/new">
            <Icons.Plus size={15} />
            Capture the first one
          </ButtonLink>
        ) : undefined,
      }}
    />
  )
}

const categoryColumns: Column<CategoryRow>[] = [
  {
    key: 'category',
    header: 'Category',
    cell: (r) => (
      <>
        <span className="text-ink">{r.name}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {r.accountCode} · {r.count} expense{r.count === 1 ? '' : 's'}
        </span>
      </>
    ),
    sortValue: (r) => r.name,
  },
  {
    key: 'change',
    header: 'Change',
    // Change against the prior period is what makes a figure worth reading.
    // Only flagged when it is material.
    cell: (r) =>
      r.changePct !== null && Math.abs(r.changePct) >= 20 ? (
        <Badge tone={r.changePct > 0 ? 'warning' : 'success'}>
          {r.changePct > 0 ? '+' : ''}
          {r.changePct}%
        </Badge>
      ) : r.changePct === null && r.total > 0 ? (
        <Badge tone="brand">New</Badge>
      ) : (
        <span className="text-faint">—</span>
      ),
    sortValue: (r) => r.changePct ?? 0,
  },
  {
    key: 'share',
    header: 'Share',
    numeric: true,
    cell: (r) => <span className="text-muted">{r.sharePct}%</span>,
    sortValue: (r) => r.sharePct,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    cell: (r) => <span className="text-ink">{formatMoney(r.total)}</span>,
    sortValue: (r) => r.total,
  },
]

export function SpendByCategoryTable({ rows }: { rows: CategoryRow[] }) {
  return <DataTable columns={categoryColumns} rows={rows} getRowKey={(r) => r.categoryId} />
}

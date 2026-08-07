'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { Badge, ButtonLink, DataTable, type Column } from '@/components/ui'
import { WriteOffActions } from './WriteOffActions'

/**
 * The write-offs screen's tables, as client components.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns (and the actions render prop) are functions, which cannot cross the
 * server→client boundary. The page maps the figures into plain rows; the
 * columns live here.
 */

export type PostedWriteOffRow = {
  id: number
  customerId: number
  customerName: string
  userName: string
  approvedBy: string | null
  writeOffDate: string
  categoryLabel: string | null
  reason: string | null
  recovered: boolean
  amount: number
}

export function PostedWriteOffsTable({ rows }: { rows: PostedWriteOffRow[] }) {
  const columns: Column<PostedWriteOffRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (w) => (
        <>
          <Link href={`/customers/${w.customerId}`} className="text-ink hover:text-brand">
            {w.customerName}
          </Link>
          <span className="mt-0.5 block text-xs text-muted">
            {w.userName}
            {w.approvedBy && w.approvedBy !== w.userName
              ? `, approved by ${w.approvedBy}`
              : w.approvedBy
                ? ', self-approved'
                : ''}
          </span>
        </>
      ),
      sortValue: (w) => w.customerName,
    },
    {
      key: 'date',
      header: 'Date',
      cell: (w) => w.writeOffDate,
      sortValue: (w) => w.writeOffDate,
    },
    {
      key: 'category',
      header: 'Category',
      cell: (w) => <span className="text-muted">{w.categoryLabel}</span>,
      sortValue: (w) => w.categoryLabel ?? '',
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (w) => <span className="line-clamp-2 max-w-md text-muted">{w.reason}</span>,
      sortValue: (w) => w.reason ?? '',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (w) =>
        w.recovered ? <Badge tone="success">Recovered</Badge> : <span className="text-faint">—</span>,
      sortValue: (w) => (w.recovered ? 1 : 0),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (w) => <span className="text-ink">{formatMoney(w.amount)}</span>,
      sortValue: (w) => w.amount,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(w) => w.id}
      actionsOnHover
      actions={(w) =>
        w.recovered ? null : (
          <WriteOffActions id={w.id} mode="recover" customerName={w.customerName} />
        )
      }
      empty={{
        title: 'Nothing has been written off',
        hint: "When a debt becomes uncollectable, write it off from the customer's account so the reason and the approval are on record.",
        action: (
          <ButtonLink href="/customers" variant="secondary">
            Open customers
          </ButtonLink>
        ),
      }}
    />
  )
}

export type CategoryRow = {
  category: string
  categoryLabel: string | null
  count: number
  total: number
}

export function CategoryTable({ rows }: { rows: CategoryRow[] }) {
  const columns: Column<CategoryRow>[] = [
    {
      key: 'category',
      header: 'Category',
      cell: (r) => <span className="text-ink">{r.categoryLabel}</span>,
      sortValue: (r) => r.categoryLabel ?? '',
    },
    {
      key: 'count',
      header: 'Write-offs',
      numeric: true,
      cell: (r) => r.count,
      sortValue: (r) => r.count,
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (r) => <span className="text-ink">{formatMoney(r.total)}</span>,
      sortValue: (r) => r.total,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.category} />
}

export type CandidateRow = {
  customerId: number
  name: string
  code: string
  daysSinceActivity: number
  oldestDue: string | null
  balance: number
}

export function CandidatesTable({ rows }: { rows: CandidateRow[] }) {
  const columns: Column<CandidateRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (c) => (
        <>
          <Link href={`/customers/${c.customerId}`} className="text-ink hover:text-brand">
            {c.name}
          </Link>
          <span className="ml-2 text-xs text-muted">{c.code}</span>
        </>
      ),
      sortValue: (c) => c.name,
    },
    {
      key: 'quiet',
      header: 'Quiet for',
      numeric: true,
      cell: (c) => `${c.daysSinceActivity} days`,
      sortValue: (c) => c.daysSinceActivity,
    },
    {
      key: 'oldest',
      header: 'Oldest due',
      cell: (c) => <span className="text-muted">{c.oldestDue ?? '—'}</span>,
      sortValue: (c) => c.oldestDue ?? '',
    },
    {
      key: 'balance',
      header: 'Balance',
      numeric: true,
      cell: (c) => <span className="text-ink">{formatMoney(c.balance)}</span>,
      sortValue: (c) => c.balance,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(c) => c.customerId} />
}

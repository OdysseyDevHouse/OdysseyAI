'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { DataTable, type Column } from '@/components/ui'

/**
 * The trial-balance screen's tables, as client components.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns are functions, which cannot cross the server→client boundary. The
 * page maps the figures into plain rows; the columns live here.
 */

export type TrialBalanceRow = {
  accountId: number
  accountCode: string
  name: string
  accountType: string
  debit: number
  credit: number
}

export function TrialBalanceTable({ rows }: { rows: TrialBalanceRow[] }) {
  const columns: Column<TrialBalanceRow>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      cell: (row) => <span className="numeric text-muted">{row.accountCode}</span>,
      sortValue: (row) => row.accountCode,
    },
    {
      key: 'account',
      header: 'Account',
      sortable: true,
      cell: (row) => (
        <Link href={`/accounting/accounts/${row.accountId}`} className="text-ink hover:text-brand">
          {row.name}
        </Link>
      ),
      sortValue: (row) => row.name,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (row) => <span className="text-muted capitalize">{row.accountType}</span>,
      sortValue: (row) => row.accountType,
    },
    {
      key: 'debit',
      header: 'Debit',
      numeric: true,
      sortable: true,
      cell: (row) =>
        row.debit === 0 ? <span className="text-faint">—</span> : formatMoney(row.debit),
      sortValue: (row) => row.debit,
    },
    {
      key: 'credit',
      header: 'Credit',
      numeric: true,
      sortable: true,
      cell: (row) =>
        row.credit === 0 ? <span className="text-faint">—</span> : formatMoney(row.credit),
      sortValue: (row) => row.credit,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.accountId}
      empty={{
        title: 'Nothing posted yet',
        hint: 'The ledger fills in as sales, purchases and expenses are captured.',
      }}
    />
  )
}

export type ControlDriftRow = {
  accountCode: string
  name: string
  glBalance: number
  subledgerBalance: number
  drift: number
}

export function ControlDriftTable({ rows }: { rows: ControlDriftRow[] }) {
  const columns: Column<ControlDriftRow>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (c) => (
        <span className="text-ink">
          <span className="numeric mr-2 text-muted">{c.accountCode}</span>
          {c.name}
        </span>
      ),
      sortValue: (c) => c.accountCode,
    },
    {
      key: 'ledger',
      header: 'Ledger',
      numeric: true,
      cell: (c) => formatMoney(c.glBalance),
      sortValue: (c) => c.glBalance,
    },
    {
      key: 'subledger',
      header: 'Subledger',
      numeric: true,
      cell: (c) => formatMoney(c.subledgerBalance),
      sortValue: (c) => c.subledgerBalance,
    },
    {
      key: 'drift',
      header: 'Out by',
      numeric: true,
      cell: (c) => <span className="text-warning-ink">{formatMoney(c.drift)}</span>,
      sortValue: (c) => c.drift,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(c) => c.accountCode} />
}

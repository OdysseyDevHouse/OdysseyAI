'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, type Column } from '@/components/ui'

/**
 * The chart-of-accounts table, as a client component.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns are functions, which cannot cross the server→client boundary. The
 * page filters and maps the rows; the columns live here.
 */

export type AccountRow = {
  id: number
  accountCode: string
  name: string
  isActive: boolean
  /** Why a control account cannot be posted to by hand — precomputed server-side. */
  controlHint: string | null
  subtypeLabel: string
  balance: number
  displayBalance: number
}

export function AccountsTable({
  rows,
  empty,
}: {
  rows: AccountRow[]
  empty: { title: string; hint: string }
}) {
  const columns: Column<AccountRow>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      cell: (a) => <span className="numeric text-muted">{a.accountCode}</span>,
      sortValue: (a) => a.accountCode,
      width: 'w-24',
    },
    {
      key: 'account',
      header: 'Account',
      sortable: true,
      cell: (a) => (
        <>
          <Link
            href={`/accounting/accounts/${a.id}`}
            className={a.isActive ? 'text-ink hover:text-brand' : 'text-muted hover:text-brand'}
          >
            {a.name}
          </Link>
          {/* A control account cannot be posted to by hand, and
              saying WHY is more useful than a greyed button. */}
          {a.controlHint && (
            <span className="mt-0.5 block text-xs text-muted">{a.controlHint}</span>
          )}
        </>
      ),
      sortValue: (a) => a.name,
    },
    {
      key: 'grouping',
      header: 'Grouping',
      cell: (a) => (
        <div className="flex items-center gap-2">
          <span className="text-muted">{a.subtypeLabel}</span>
          {!a.isActive && <Badge tone="default">Hidden</Badge>}
        </div>
      ),
      sortValue: (a) => a.subtypeLabel ?? '',
    },
    {
      key: 'balance',
      header: 'Balance',
      numeric: true,
      sortable: true,
      cell: (a) =>
        a.balance === 0 ? <span className="text-faint">—</span> : formatMoney(a.displayBalance),
      sortValue: (a) => a.displayBalance,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(a) => a.id} empty={empty} />
}

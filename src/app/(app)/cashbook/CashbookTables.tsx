'use client'

import Link from 'next/link'
import { DataTable, Badge, ButtonLink, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { listAccounts, reconcileBankBalances } from '@/lib/site/bankAccounts'
import type { unidentifiedBankReceipts } from '@/lib/site/unallocatedReceipts'

/**
 * The cashbook tables. Client components only because DataTable's columns
 * carry cell functions, which a Server Component cannot hand across the
 * boundary — the page passes plain, serialisable rows down.
 */

type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number]
type DriftRow = Awaited<ReturnType<typeof reconcileBankBalances>>[number]
type UnidentifiedRow = Awaited<ReturnType<typeof unidentifiedBankReceipts>>[number]

const accountColumns: Column<AccountRow>[] = [
  {
    key: 'name',
    header: 'Account',
    cell: (a) => (
      <Link href={`/cashbook/${a.id}`} className="block hover:text-brand">
        <span className="font-medium text-ink">{a.name}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {a.code}
          {a.bankName ? ` · ${a.bankName}` : ''}
          {a.accountNumber ? ` · ${a.accountNumber}` : ''}
        </span>
      </Link>
    ),
    sortValue: (a) => a.name,
  },
  {
    key: 'type',
    header: 'Type',
    cell: (a) => <Badge tone="default">{a.accountTypeLabel}</Badge>,
    sortValue: (a) => a.accountType,
  },
  {
    key: 'reconciled',
    header: 'Last reconciled',
    cell: (a) =>
      a.accountType !== 'bank' ? (
        <span className="text-faint">—</span>
      ) : a.lastReconciledDate ? (
        <span className="text-ink-2">{a.lastReconciledDate}</span>
      ) : (
        // Never reconciled is a real state, not a blank: it means every
        // figure on this account is unverified.
        <Badge tone="warning">Never</Badge>
      ),
    sortValue: (a) => a.lastReconciledDate ?? '',
  },
  {
    key: 'unreconciled',
    header: 'Unmatched',
    cell: (a) =>
      (a.unreconciledCount ?? 0) === 0 ? (
        <span className="text-faint">—</span>
      ) : (
        <Badge tone={(a.unreconciledCount ?? 0) > 20 ? 'warning' : 'default'}>
          {a.unreconciledCount}
        </Badge>
      ),
    sortValue: (a) => a.unreconciledCount ?? 0,
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    cell: (a) => (
      <span className={a.balance < 0 ? 'text-danger' : 'text-ink'}>
        {formatMoney(a.balance)}
      </span>
    ),
    sortValue: (a) => a.balance,
  },
]

export function AccountsTable({ rows }: { rows: AccountRow[] }) {
  return (
    <DataTable
      columns={accountColumns}
      rows={rows}
      getRowKey={(a) => a.id}
      empty={{
        title: 'No accounts yet',
        hint: 'Add the bank account your takings are deposited into, and the cashbook can start reconciling against a statement.',
        action: (
          <ButtonLink href="/cashbook/new">
            <Icons.Plus size={15} />
            New account
          </ButtonLink>
        ),
      }}
    />
  )
}

const driftColumns: Column<DriftRow>[] = [
  {
    key: 'account',
    header: 'Account',
    cell: (d) => (
      <span className="text-ink">
        {d.code} — {d.name}
      </span>
    ),
    sortValue: (d) => d.code,
  },
  {
    key: 'drift',
    header: 'Out by',
    numeric: true,
    // Every drift is a bug, so danger here marks a genuine exception rather
    // than decorating a column.
    cell: (d) => <span className="text-danger">{formatMoney(d.drift)}</span>,
    sortValue: (d) => d.drift,
  },
]

export function DriftTable({ rows }: { rows: DriftRow[] }) {
  return <DataTable columns={driftColumns} rows={rows} getRowKey={(d) => d.id} />
}

const unidentifiedColumns: Column<UnidentifiedRow>[] = [
  {
    key: 'receipt',
    header: 'Receipt',
    cell: (r) => (
      <>
        <span className="block truncate text-ink">
          {r.description ?? r.reference ?? 'No description'}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          {r.txnDate} · {r.bankAccountName}
        </span>
      </>
    ),
    sortValue: (r) => r.txnDate,
  },
  {
    key: 'held',
    header: 'Held',
    cell: (r) =>
      // A receipt sitting unidentified for a month is somebody's invoice
      // wrongly in arrears — that is the exception worth marking.
      r.daysHeld > 30 ? (
        <Badge tone="warning">{r.daysHeld} days</Badge>
      ) : (
        <span className="text-ink-2">
          {r.daysHeld} day{r.daysHeld === 1 ? '' : 's'}
        </span>
      ),
    sortValue: (r) => r.daysHeld,
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    cell: (r) => formatMoney(r.amount),
    sortValue: (r) => r.amount,
  },
]

export function UnidentifiedReceiptsTable({ rows }: { rows: UnidentifiedRow[] }) {
  return <DataTable columns={unidentifiedColumns} rows={rows} getRowKey={(r) => r.bankTxnId} />
}

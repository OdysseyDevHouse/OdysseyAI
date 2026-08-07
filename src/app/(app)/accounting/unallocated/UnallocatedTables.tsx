'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, type Column } from '@/components/ui'
import { AllocateButton } from './AllocateButton'

/**
 * The unallocated-money screen's tables, as client components.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns (and the actions render prop) are functions, which cannot cross the
 * server→client boundary. The page maps the figures into plain rows; the
 * columns live here.
 */

export type UnidentifiedRow = {
  bankTxnId: number
  description: string | null
  reference: string | null
  txnDate: string
  bankAccountName: string
  daysHeld: number
  amount: number
}

export function UnidentifiedTable({ rows }: { rows: UnidentifiedRow[] }) {
  const columns: Column<UnidentifiedRow>[] = [
    {
      key: 'description',
      header: 'Description',
      cell: (r) => (
        <span className="block max-w-md truncate text-ink">
          {r.description ?? r.reference ?? 'No description'}
        </span>
      ),
      sortValue: (r) => r.description ?? r.reference ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (r) => r.txnDate,
      sortValue: (r) => r.txnDate,
    },
    {
      key: 'bank',
      header: 'Bank account',
      cell: (r) => <span className="text-muted">{r.bankAccountName}</span>,
      sortValue: (r) => r.bankAccountName,
    },
    {
      key: 'days',
      header: 'Days held',
      numeric: true,
      cell: (r) =>
        r.daysHeld > 90 ? <Badge tone="warning">{r.daysHeld} days</Badge> : r.daysHeld,
      sortValue: (r) => r.daysHeld,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (r) => <span className="text-ink">{formatMoney(r.amount)}</span>,
      sortValue: (r) => r.amount,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.bankTxnId} />
}

export type CustomerCreditRow = {
  txnId: number
  customerId: number
  customerName: string
  customerCode: string
  docType: string
  docNumber: string | null
  docDate: string
  reference: string | null
  daysHeld: number
  canAllocate: boolean
  openDebt: number
  unapplied: number
}

export function CustomerCreditsTable({ rows }: { rows: CustomerCreditRow[] }) {
  const columns: Column<CustomerCreditRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (c) => (
        <>
          <Link href={`/customers/${c.customerId}`} className="text-ink hover:text-brand">
            {c.customerName}
          </Link>
          <span className="mt-0.5 block text-xs text-muted">
            {c.customerCode} · {c.docType.replace('_', ' ')}
            {c.docNumber ? ` ${c.docNumber}` : ''} · {c.docDate}
            {c.reference ? ` · ${c.reference}` : ''}
          </span>
        </>
      ),
      sortValue: (c) => c.customerName,
    },
    {
      key: 'days',
      header: 'Days held',
      numeric: true,
      cell: (c) =>
        c.daysHeld > 90 ? <Badge tone="warning">{c.daysHeld} days</Badge> : c.daysHeld,
      sortValue: (c) => c.daysHeld,
    },
    {
      key: 'open',
      header: 'Invoices open',
      numeric: true,
      cell: (c) =>
        c.canAllocate ? formatMoney(c.openDebt) : <span className="text-faint">—</span>,
      sortValue: (c) => (c.canAllocate ? c.openDebt : 0),
    },
    {
      key: 'unapplied',
      header: 'Unapplied',
      numeric: true,
      cell: (c) => <span className="text-ink">{formatMoney(c.unapplied)}</span>,
      sortValue: (c) => c.unapplied,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(c) => c.txnId}
      actionsOnHover
      actions={(c) => (
        <AllocateButton txnId={c.txnId} customerName={c.customerName} disabled={!c.canAllocate} />
      )}
      empty={{
        title: 'Everything is allocated',
        hint: 'Every customer payment has been matched against the invoices it settles.',
      }}
    />
  )
}

export type SupplierCreditRow = {
  txnId: number
  supplierId: number
  supplierName: string
  supplierCode: string
  docNumber: string | null
  docDate: string
  daysHeld: number
  canAllocate: boolean
  openDebt: number
  unapplied: number
}

export function SupplierCreditsTable({ rows }: { rows: SupplierCreditRow[] }) {
  const columns: Column<SupplierCreditRow>[] = [
    {
      key: 'supplier',
      header: 'Supplier',
      cell: (c) => (
        <>
          <Link href={`/suppliers/${c.supplierId}`} className="text-ink hover:text-brand">
            {c.supplierName}
          </Link>
          <span className="mt-0.5 block text-xs text-muted">
            {c.supplierCode}
            {c.docNumber ? ` · ${c.docNumber}` : ''} · {c.docDate}
          </span>
        </>
      ),
      sortValue: (c) => c.supplierName,
    },
    {
      key: 'days',
      header: 'Days held',
      numeric: true,
      cell: (c) =>
        c.daysHeld > 90 ? <Badge tone="warning">{c.daysHeld} days</Badge> : c.daysHeld,
      sortValue: (c) => c.daysHeld,
    },
    {
      key: 'open',
      header: 'Invoices open',
      numeric: true,
      cell: (c) =>
        c.canAllocate ? formatMoney(c.openDebt) : <span className="text-faint">—</span>,
      sortValue: (c) => (c.canAllocate ? c.openDebt : 0),
    },
    {
      key: 'unapplied',
      header: 'Unapplied',
      numeric: true,
      cell: (c) => <span className="text-ink">{formatMoney(c.unapplied)}</span>,
      sortValue: (c) => c.unapplied,
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(c) => c.txnId} />
}

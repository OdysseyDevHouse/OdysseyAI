'use client'

import type { ReactNode } from 'react'
import { DataTable, Badge, type Column } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type {
  DailyRow,
  GroupedRow,
  TenderRow,
  VatRow,
  ExceptionRow,
} from '@/lib/site/salesReports'

/**
 * The report tables, one per tab.
 *
 * They live in a client file because DataTable's columns carry cell functions,
 * which a Server Component cannot hand across the boundary — the page passes
 * plain rows and these components decide how each figure renders and sorts.
 */

/** DataTable's empty prop, threaded through from the server page. */
type Empty = { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }

type SlowMover = { id: number; code: string; description: string; onHand: number; value: number }

/** Margin as a badge: below zero is a loss, thin is worth a second look.
    (Local copy of the dashboard RankedTable's thresholds — keep them in step.) */
function marginTone(value: number): 'danger' | 'warning' | 'success' {
  if (value < 0) return 'danger'
  if (value < 10) return 'warning'
  return 'success'
}

/** A money figure that flags a loss without decorating a profit. */
function money(value: number) {
  return <span className={value < 0 ? 'text-danger' : undefined}>{formatMoney(value)}</span>
}

/** GP% as a badge — the one column in these reports that carries a judgement. */
function gpBadge(row: { profit: number; gpPct: number }) {
  return (
    <Badge tone={row.profit < 0 ? 'danger' : marginTone(row.gpPct)}>
      {row.gpPct.toFixed(1)}%
    </Badge>
  )
}

export function DayTable({ rows, empty, showProfit }: { rows: DailyRow[]; empty: Empty; showProfit: boolean }) {
  const columns: Column<DailyRow>[] = [
    { key: 'date', header: 'Date', sortable: true, cell: (r) => r.date },
    {
      key: 'sales',
      header: 'Sales',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.salesIncl,
      cell: (r) => formatMoney(r.salesIncl),
    },
    {
      key: 'documents',
      header: 'Documents',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.documents,
      cell: (r) => r.documents,
    },
  ]
  if (showProfit) {
    columns.push({
      key: 'profit',
      header: 'Profit',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.profit,
      cell: (r) => money(r.profit),
    })
  }
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.date} empty={empty} />
}

export function SlowMoversTable({ rows, empty }: { rows: SlowMover[]; empty: Empty }) {
  const columns: Column<SlowMover>[] = [
    { key: 'code', header: 'Code', sortable: true, cell: (r) => r.code },
    { key: 'product', header: 'Product', sortable: true, cell: (r) => r.description },
    {
      key: 'onHand',
      header: 'On hand',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.onHand,
      cell: (r) => formatQty(r.onHand),
    },
    {
      key: 'value',
      header: 'Stock value',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.value,
      cell: (r) => formatMoney(r.value),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} empty={empty} />
}

export function ProductsTable({ rows, empty, showProfit }: { rows: GroupedRow[]; empty: Empty; showProfit: boolean }) {
  const columns: Column<GroupedRow>[] = [
    { key: 'code', header: 'Code', sortable: true, cell: (r) => r.key },
    { key: 'product', header: 'Product', sortable: true, cell: (r) => r.label },
    {
      key: 'qty',
      header: 'Qty',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.qty,
      cell: (r) => formatQty(r.qty),
    },
    ...moneyAndMarginColumns(showProfit),
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.key} empty={empty} />
}

export function DepartmentsTable({ rows, empty, showProfit }: { rows: GroupedRow[]; empty: Empty; showProfit: boolean }) {
  const columns: Column<GroupedRow>[] = [
    { key: 'department', header: 'Department', sortable: true, cell: (r) => r.label },
    {
      key: 'qty',
      header: 'Qty',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.qty,
      cell: (r) => formatQty(r.qty),
    },
    ...moneyAndMarginColumns(showProfit),
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.key} empty={empty} />
}

export function CashiersTable({ rows, empty, showProfit }: { rows: GroupedRow[]; empty: Empty; showProfit: boolean }) {
  const columns: Column<GroupedRow>[] = [
    { key: 'cashier', header: 'Cashier', sortable: true, cell: (r) => r.label },
    {
      key: 'documents',
      header: 'Documents',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.documents,
      cell: (r) => r.documents,
    },
    ...moneyAndMarginColumns(showProfit),
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.key} empty={empty} />
}

/**
 * Sales, and — for whoever may see it — profit and margin.
 *
 * `showProfit` rather than always: `reports.view` opens the screen and
 * `reports.financial` is what puts margin on it. A supervisor checking which
 * products moved does not need to know what the shop makes on them.
 */
function moneyAndMarginColumns(showProfit: boolean): Column<GroupedRow>[] {
  const columns: Column<GroupedRow>[] = [
    {
      key: 'sales',
      header: 'Sales',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.salesIncl,
      cell: (r) => formatMoney(r.salesIncl),
    },
  ]

  if (showProfit) {
    columns.push(
      {
        key: 'profit',
        header: 'Profit',
        numeric: true,
        sortable: true,
        sortValue: (r) => r.profit,
        cell: (r) => money(r.profit),
      },
      {
        key: 'gpPct',
        header: 'GP %',
        numeric: true,
        sortable: true,
        sortValue: (r) => r.gpPct,
        cell: (r) => gpBadge(r),
      },
    )
  }

  return columns
}

export function TendersTable({ rows, empty }: { rows: TenderRow[]; empty: Empty }) {
  const columns: Column<TenderRow>[] = [
    { key: 'tender', header: 'Tender', sortable: true, cell: (r) => r.tenderName },
    {
      key: 'drawer',
      header: 'In the drawer',
      sortable: true,
      sortValue: (r) => (r.countsAsDrawerCash ? 'Yes' : 'Bank'),
      cell: (r) => (r.countsAsDrawerCash ? 'Yes' : 'Bank'),
    },
    {
      key: 'transactions',
      header: 'Transactions',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.transactions,
      cell: (r) => r.transactions,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.amount,
      cell: (r) => money(r.amount),
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => `${r.tenderCode}:${r.tenderName}`}
      empty={empty}
    />
  )
}

export function VatTable({ rows, empty }: { rows: VatRow[]; empty: Empty }) {
  const columns: Column<VatRow>[] = [
    {
      key: 'rate',
      header: 'Rate',
      sortable: true,
      sortValue: (r) => r.ratePct,
      cell: (r) => (r.ratePct === 0 ? 'Zero-rated' : `${r.ratePct}%`),
    },
    {
      key: 'excl',
      header: 'Excluding VAT',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.excl,
      cell: (r) => formatMoney(r.excl),
    },
    {
      key: 'vat',
      header: 'VAT',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.vat,
      cell: (r) => formatMoney(r.vat),
    },
    {
      key: 'incl',
      header: 'Including VAT',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.incl,
      cell: (r) => formatMoney(r.incl),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.ratePct} empty={empty} />
}

export function ExceptionsTable({ rows, empty }: { rows: ExceptionRow[]; empty: Empty }) {
  const columns: Column<ExceptionRow>[] = [
    { key: 'cashier', header: 'Cashier', sortable: true, cell: (r) => r.userName },
    {
      key: 'voids',
      header: 'Cancelled',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.voids,
      cell: (r) => r.voids || '—',
    },
    {
      key: 'voidValue',
      header: 'Cancelled value',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.voidValue,
      cell: (r) => (r.voidValue ? formatMoney(r.voidValue) : '—'),
    },
    {
      key: 'discountValue',
      header: 'Discounts',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.discountValue,
      cell: (r) => (r.discountValue ? formatMoney(r.discountValue) : '—'),
    },
    {
      key: 'creditValue',
      header: 'Credits',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.creditValue,
      cell: (r) => (r.creditValue ? formatMoney(r.creditValue) : '—'),
    },
    {
      key: 'noReceipt',
      header: 'No receipt',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.noReceiptReturns,
      // The easiest way to take money out of a till: there is no original
      // sale to check the return against.
      cell: (r) =>
        r.noReceiptReturns > 0 ? (
          <Badge tone="warning">{r.noReceiptReturns}</Badge>
        ) : (
          <span className="text-faint">0</span>
        ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.userId} empty={empty} />
}

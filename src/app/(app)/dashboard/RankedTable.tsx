'use client'

import { DataTable, Badge, type Column } from '@/components/ui'
import type { DetailDimension, RankedRow } from '@/lib/site/salesDashboard'
import { money, qty, count, percent } from './format'

/**
 * The "top performers" table, shared by products, departments and cashiers —
 * all three aggregate to the same shape, so all three get the same columns.
 *
 * GP% is a badge rather than a plain number because it is the column that
 * carries a judgement: a negative margin is something to act on, and it has to
 * survive being scanned rather than read. Everything else in the row is a
 * plain figure, which is what keeps the badge meaning something.
 */

export type TableConfig = {
  dimension: DetailDimension
  nameHeader: string
  emptyTitle: string
  /** Products lead with quantity; the others lead with turnover. */
  showQty: boolean
  initialSort: 'qty' | 'turnoverIncl'
}

export const TABLE_CONFIG: Record<DetailDimension, TableConfig> = {
  products: {
    dimension: 'products',
    nameHeader: 'Product',
    emptyTitle: 'No products sold',
    showQty: true,
    initialSort: 'qty',
  },
  departments: {
    dimension: 'departments',
    nameHeader: 'Department',
    emptyTitle: 'No departments sold',
    showQty: false,
    initialSort: 'turnoverIncl',
  },
  cashiers: {
    dimension: 'cashiers',
    nameHeader: 'Cashier',
    emptyTitle: 'No sales by cashier',
    showQty: false,
    initialSort: 'turnoverIncl',
  },
}

/** Margin as a badge: below zero is a loss, thin is worth a second look. */
function marginTone(value: number): 'danger' | 'warning' | 'success' {
  if (value < 0) return 'danger'
  if (value < 10) return 'warning'
  return 'success'
}

export function RankedTable({ rows, config }: { rows: RankedRow[]; config: TableConfig }) {
  const columns: Column<RankedRow>[] = [
    {
      key: 'label',
      header: config.nameHeader,
      cell: (r) => (
        <span className="block truncate font-medium text-ink" title={r.label}>
          {r.label}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.label.toLowerCase(),
    },
    ...(config.showQty
      ? [
          {
            key: 'qty',
            header: 'Qty',
            numeric: true,
            sortable: true,
            sortValue: (r: RankedRow) => r.qty,
            cell: (r: RankedRow) => qty(r.qty),
            width: 'w-24',
          } satisfies Column<RankedRow>,
        ]
      : [
          {
            key: 'saleCount',
            header: 'Sales',
            numeric: true,
            sortable: true,
            sortValue: (r: RankedRow) => r.saleCount,
            cell: (r: RankedRow) => count(r.saleCount),
            width: 'w-24',
          } satisfies Column<RankedRow>,
        ]),
    {
      key: 'turnoverIncl',
      header: 'Turnover',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.turnoverIncl,
      cell: (r) => money(r.turnoverIncl),
      width: 'w-36',
    },
    {
      key: 'grossProfit',
      header: 'GP',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.grossProfit,
      cell: (r) => (
        <span className={r.grossProfit < 0 ? 'text-danger' : undefined}>
          {money(r.grossProfit)}
        </span>
      ),
      width: 'w-32',
    },
    {
      key: 'grossProfitPct',
      header: 'GP %',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.grossProfitPct,
      cell: (r) => <Badge tone={marginTone(r.grossProfitPct)}>{percent(r.grossProfitPct)}</Badge>,
      width: 'w-24',
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.key}
      empty={{
        title: config.emptyTitle,
        hint: 'Nothing was sold in this period. Try a wider date range.',
      }}
    />
  )
}

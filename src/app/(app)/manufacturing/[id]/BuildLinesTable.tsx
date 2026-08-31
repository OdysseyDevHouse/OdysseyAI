'use client'

import { DataTable, Icons, type Column } from '@/components/ui'
import { formatCost, formatMoney, formatQty } from '@/lib/decimals'

/**
 * What a build consumed.
 *
 * These figures are the SNAPSHOT taken when the build posted, not a live read
 * of the recipe. A recipe edited in March must not restate what a build in
 * January consumed — the movements are already written, and the two would
 * disagree with nothing to explain the difference.
 */

export type BuildLineRow = {
  id: number
  productId: number
  productCode: string
  description: string
  qtyPerUnit: number
  qtyConsumed: number
  unitCostExcl: number
  lineCostExcl: number
}

export default function BuildLinesTable({ rows }: { rows: BuildLineRow[] }) {
  const columns: Column<BuildLineRow>[] = [
    {
      key: 'product',
      header: 'Ingredient',
      cell: (l) => (
        <span className="flex flex-col">
          <span className="text-ink">{l.description}</span>
          <span className="text-xs text-muted">{l.productCode}</span>
        </span>
      ),
      sortValue: (l) => l.description,
    },
    {
      key: 'perUnit',
      header: 'Per one',
      numeric: true,
      cell: (l) => formatQty(l.qtyPerUnit),
      sortValue: (l) => l.qtyPerUnit,
    },
    {
      key: 'consumed',
      header: 'Used',
      numeric: true,
      cell: (l) => formatQty(l.qtyConsumed),
      sortValue: (l) => l.qtyConsumed,
    },
    {
      key: 'unitCost',
      header: 'Unit cost',
      numeric: true,
      cell: (l) => formatCost(l.unitCostExcl),
      sortValue: (l) => l.unitCostExcl,
    },
    {
      key: 'lineCost',
      header: 'Cost',
      numeric: true,
      cell: (l) => formatMoney(l.lineCostExcl),
      sortValue: (l) => l.lineCostExcl,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(l) => l.id}
      empty={{
        title: 'No ingredients recorded',
        hint: 'A posted build always snapshots what it consumed, so an empty list here means something went wrong.',
        icon: <Icons.StatusWarning size={22} />,
      }}
    />
  )
}

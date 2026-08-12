'use client'

import Link from 'next/link'
import { Badge, DataTable, Icons, Menu, MenuItem, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

/**
 * The fixed-asset register table.
 *
 * A client component because DataTable is one, and a Column carries `cell` and
 * `sortValue` — functions, which cannot cross the server/client boundary.
 * Defining them on the page fails the render outright, and the failure hides
 * until there is at least one row: an empty register early-returns an
 * EmptyState and never reaches DataTable at all.
 */

export type AssetTableRow = {
  id: number
  assetCode: string
  name: string
  serialNumber: string | null
  location: string | null
  categoryName: string | null
  status: string
  fullyDepreciated: boolean
  cost: number
  accumulatedDepreciation: number
  bookValue: number
}

export function AssetsTable({ rows }: { rows: AssetTableRow[] }) {
  const columns: Column<AssetTableRow>[] = [
    {
      key: 'asset',
      header: 'Asset',
      cell: (a) => (
        <Link href={`/accounting/assets/${a.id}`} className="block hover:text-brand">
          <span className="text-ink">{a.name}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {a.assetCode}
            {a.serialNumber ? ` · ${a.serialNumber}` : ''}
            {a.location ? ` · ${a.location}` : ''}
          </span>
        </Link>
      ),
      sortValue: (a) => a.name,
    },
    {
      key: 'category',
      header: 'Category',
      cell: (a) => <span className="text-muted">{a.categoryName}</span>,
      sortValue: (a) => a.categoryName ?? '',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (a) =>
        a.status === 'disposed' ? (
          <Badge dot tone="default">
            Disposed
          </Badge>
        ) : a.status === 'pending' ? (
          <Badge dot tone="warning">
            Not in use
          </Badge>
        ) : a.fullyDepreciated ? (
          // Still owned and still on the balance sheet, but no longer a cost.
          <Badge dot tone="default">
            Fully depreciated
          </Badge>
        ) : (
          <Badge dot tone="success">
            In use
          </Badge>
        ),
      sortValue: (a) => a.status,
    },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      cell: (a) => formatMoney(a.cost),
      sortValue: (a) => a.cost,
    },
    {
      key: 'accumulated',
      header: 'Depreciated',
      numeric: true,
      cell: (a) => <span className="text-muted">{formatMoney(a.accumulatedDepreciation)}</span>,
      sortValue: (a) => a.accumulatedDepreciation,
    },
    {
      key: 'book',
      header: 'Book value',
      numeric: true,
      cell: (a) => <span className="text-ink">{formatMoney(a.bookValue)}</span>,
      sortValue: (a) => a.bookValue,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(a) => a.id}
      actions={(a) => (
        <Menu
          iconOnly
          size="sm"
          variant="bare"
          triggerLabel={`Actions for ${a.assetCode || a.name}`}
          label={<Icons.MoreVertical size={16} />}
        >
          <MenuItem href={`/accounting/assets/${a.id}`}>
            <Icons.Eye size={15} />
            View asset
          </MenuItem>
          <MenuItem href={`/accounting/assets/${a.id}/edit`}>
            <Icons.Pencil size={15} />
            Edit
          </MenuItem>
        </Menu>
      )}
      empty={{ title: 'No assets', hint: 'Nothing in this filter.' }}
    />
  )
}

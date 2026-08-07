'use client'

import Link from 'next/link'
import { Pencil } from '@/components/ui/icons'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  Badge,
  ButtonLink,
  DataTable,
  RowTile,
  TextLink,
  type Column,
} from '@/components/ui'
import type { listProducts } from '@/lib/site/products'

type ProductRow = Awaited<ReturnType<typeof listProducts>>['items'][number]
type Empty = { title: string; hint?: string; icon?: React.ReactNode; action?: React.ReactNode }

/** The shelf price: the structure flagged default, else the first one. */
function defaultPrice(p: ProductRow) {
  return p.prices.find((x) => x.isDefault) ?? p.prices[0]
}

/**
 * The product list table.
 *
 * A client component because DataTable's columns carry `cell` functions, and a
 * function cannot cross the server/client boundary — the server page passes
 * plain rows and the flags that decide which columns exist.
 *
 * `showCost` is resolved on the SERVER from `products.cost` and passed as a
 * boolean. The cost and GP columns are then never constructed at all for a
 * role without it, rather than rendered and hidden.
 */
export default function ProductsTable({
  items,
  departmentPaths,
  costBasis,
  showCost,
  empty,
}: {
  items: ProductRow[]
  /** Department id -> its full path, resolved on the server. */
  departmentPaths: Record<number, string>
  costBasis: 'last' | 'average'
  showCost: boolean
  empty: Empty
}) {
  const columns: Column<ProductRow>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      cell: (p) => <TextLink href={`/products/${p.id}`}>{p.code}</TextLink>,
      sortValue: (p) => p.code,
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      cell: (p) => (
        <Link href={`/products/${p.id}`} className="flex items-center gap-2.5 hover:text-brand">
          <RowTile label={p.description} token={p.imageColor} />
          <span className="min-w-0 truncate text-ink">{p.description}</span>
          {p.isArchived && <Badge>Archived</Badge>}
        </Link>
      ),
      sortValue: (p) => p.description,
    },
    {
      key: 'department',
      header: 'Department',
      sortable: true,
      cell: (p) => {
        const path = p.departmentId ? departmentPaths[p.departmentId] : null
        return path ? (
          <span className="text-muted">{path}</span>
        ) : (
          <span className="text-faint">—</span>
        )
      },
      sortValue: (p) => (p.departmentId ? departmentPaths[p.departmentId] : '') || '',
    },
    {
      key: 'cost',
      header: costBasis === 'last' ? 'Last cost' : 'Avg cost',
      numeric: true,
      sortable: true,
      cell: (p) => <span className="text-muted">{formatMoney(p.cost.effective)}</span>,
      sortValue: (p) => p.cost.effective,
    },
    {
      key: 'price',
      header: 'Price incl.',
      numeric: true,
      sortable: true,
      cell: (p) => {
        const price = defaultPrice(p)
        return price ? (
          <span className="text-ink">{formatMoney(price.sellIncl)}</span>
        ) : (
          <span className="text-faint">—</span>
        )
      },
      sortValue: (p) => defaultPrice(p)?.sellIncl ?? -1,
    },
    {
      key: 'gp',
      header: 'GP %',
      numeric: true,
      sortable: true,
      // Selling below cost is the exception the eye must catch; a healthy
      // margin is just a number.
      cell: (p) => {
        const price = defaultPrice(p)
        if (!price) return <span className="text-faint">—</span>
        return price.gp < 0 ? (
          <Badge tone="danger">{price.gp.toFixed(1)}%</Badge>
        ) : (
          <span className="text-muted">{price.gp.toFixed(1)}%</span>
        )
      },
      sortValue: (p) => defaultPrice(p)?.gp ?? -1e9,
    },
    {
      key: 'stock',
      header: 'On hand',
      numeric: true,
      sortable: true,
      // State gets a form, not just a value: 0 and 142 read identically in a
      // grey column at scanning speed. Out of stock is a danger badge, below
      // minimum a warning one; normal stock stays a plain tabular figure.
      cell: (p) =>
        p.stockOnHand <= 0 ? (
          <Badge tone="danger">Out of stock</Badge>
        ) : p.belowMinimum ? (
          <Badge tone="warning">{formatQty(p.stockOnHand)}</Badge>
        ) : (
          formatQty(p.stockOnHand)
        ),
      sortValue: (p) => p.stockOnHand,
    },
  ]

  return (
    <DataTable
      columns={columns.filter((c) => showCost || (c.key !== 'cost' && c.key !== 'gp'))}
      rows={items}
      getRowKey={(p) => p.id}
      actions={(p) => (
        <ButtonLink
          href={`/products/${p.id}`}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Edit ${p.description}`}
        >
          <Pencil size={14} />
        </ButtonLink>
      )}
      actionsOnHover
      empty={empty}
    />
  )
}

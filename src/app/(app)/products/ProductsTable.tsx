'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Pencil } from '@/components/ui/icons'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  Badge,
  ButtonLink,
  DataTable,
  Icons,
  RowTile,
  TextLink,
  type Column,
} from '@/components/ui'
import type { listProducts, ProductSort } from '@/lib/site/products'

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
  groupHrefs,
  parentNames,
  dates,
  sort,
  sortHrefs,
  selectedKeys,
  onSelectionChange,
}: {
  items: ProductRow[]
  /** Department id -> its full path, resolved on the server. */
  departmentPaths: Record<number, string>
  costBasis: 'last' | 'average'
  showCost: boolean
  empty: Empty
  /**
   * Parent id -> where clicking that group goes, built on the server.
   *
   * A map rather than a function because this is a client component and the
   * URL helpers are server-side, exactly as departmentPaths is.
   */
  groupHrefs: Record<number, string>
  /**
   * Parent id -> description, for the children a search turned up.
   *
   * A search un-collapses groups (see listProducts), so "Large" on its own is
   * ambiguous across a catalogue. The parent's name restores the context the
   * collapsed list would otherwise have given.
   */
  parentNames: Record<number, string>
  /**
   * Product id -> its created and last-edited dates, already formatted.
   *
   * Strings, not Dates: a DATETIME comes back from the site pool parsed as
   * UTC, so a Date handed across this boundary would be re-read in the
   * viewer's timezone and could render the day before. The server formats,
   * the client displays.
   */
  dates: Record<number, { created: string; edited: string }>
  /**
   * Which column the SERVER ordered by. The table is told rather than sorting
   * itself: it only holds one page of a catalogue, and re-sorting 50 of 4,000
   * rows would silently answer a different question than the one asked.
   */
  sort: { key: ProductSort; direction: 'asc' | 'desc' } | null
  /**
   * "key:direction" -> the URL for that ordering, built on the server.
   *
   * A map rather than a function for the same reason groupHrefs is one: the
   * URL helpers are server-side and a function prop cannot cross into a client
   * component.
   */
  sortHrefs: Record<string, string>
  /**
   * Selection, when the list offers bulk actions. Both or neither — DataTable
   * only renders the checkbox column when it is given a pair.
   */
  selectedKeys?: ReadonlySet<string>
  onSelectionChange?: (next: ReadonlySet<string>) => void
}) {
  const router = useRouter()

  /** Where a row leads: its group if it is a parent, else its own edit form. */
  const rowHref = (p: ProductRow) =>
    (p.hasVariants ? groupHrefs[p.id] : null) ?? `/products/${p.id}`

  const columns: Column<ProductRow>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      // A parent's code is not orderable or scannable, so it points at the
      // group rather than at an edit form for a row nobody transacts against.
      cell: (p) => <TextLink href={rowHref(p)}>{p.code}</TextLink>,
    },
    {
      key: 'description',
      header: 'Product',
      sortable: true,
      cell: (p) => (
        <Link href={rowHref(p)} className="flex items-center gap-2.5 hover:text-brand">
          <RowTile label={p.description} token={p.imageColor} />
          <span className="min-w-0 truncate text-ink">{p.description}</span>
          {/* The badge is the whole point of collapsing: it says this one row
              stands for several products, and that it can be opened. */}
          {p.hasVariants && (
            <Badge tone="brand">
              {p.variantCount} variant{p.variantCount === 1 ? '' : 's'}
            </Badge>
          )}
          {/* Only when a search has un-collapsed the groups. Inside a group the
              page header already names the parent, and repeating it on all
              twenty rows is noise under a heading that just said it. */}
          {p.parentId !== null && parentNames[p.parentId] && (
            <span className="min-w-0 shrink truncate text-xs text-muted">
              in {parentNames[p.parentId]}
            </span>
          )}
          {p.isArchived && <Badge>Archived</Badge>}
        </Link>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      cell: (p) => {
        const path = p.departmentId ? departmentPaths[p.departmentId] : null
        return path ? (
          <span className="text-muted">{path}</span>
        ) : (
          <span className="text-faint">—</span>
        )
      },
    },
    {
      key: 'cost',
      header: costBasis === 'last' ? 'Last cost' : 'Avg cost',
      numeric: true,
      // A parent is never bought, so its cost columns are zeros that mean
      // "not applicable". Rendering them as R0.00 would read as free.
      cell: (p) =>
        p.hasVariants ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="text-muted">{formatMoney(p.cost.effective)}</span>
        ),
    },
    {
      key: 'price',
      header: 'Price incl.',
      numeric: true,
      cell: (p) => {
        // Variants price separately — that is the commonest reason to have
        // them — so a group has no single shelf price to show.
        if (p.hasVariants) return <span className="text-faint">—</span>
        const price = defaultPrice(p)
        return price ? (
          <span className="text-ink">{formatMoney(price.sellIncl)}</span>
        ) : (
          <span className="text-faint">—</span>
        )
      },
    },
    {
      key: 'gp',
      header: 'GP %',
      numeric: true,
      // Selling below cost is the exception the eye must catch; a healthy
      // margin is just a number.
      cell: (p) => {
        // No cost and no price means no margin — and a -100% danger badge on
        // every group would drown the real ones.
        if (p.hasVariants) return <span className="text-faint">—</span>
        const price = defaultPrice(p)
        if (!price) return <span className="text-faint">—</span>
        return price.gp < 0 ? (
          <Badge tone="danger">{price.gp.toFixed(1)}%</Badge>
        ) : (
          <span className="text-muted">{price.gp.toFixed(1)}%</span>
        )
      },
    },
    {
      key: 'stock',
      header: 'On hand',
      numeric: true,
      // State gets a form, not just a value: 0 and 142 read identically in a
      // grey column at scanning speed. Out of stock is a danger badge, below
      // minimum a warning one; normal stock stays a plain tabular figure.
      // On a group this is the total across its variants, so it answers the
      // question the row is actually asked: is there any of this shirt left.
      cell: (p) =>
        p.stockOnHand <= 0 ? (
          <Badge tone="danger">Out of stock</Badge>
        ) : p.belowMinimum ? (
          <Badge tone="warning">{formatQty(p.stockOnHand)}</Badge>
        ) : (
          formatQty(p.stockOnHand)
        ),
    },
    /* The two date columns appear only when the list is ordered by one of
       them. Carried on every screen they would be twelve characters of grey
       nobody reads; shown when they are the sort key, they are the evidence
       for the order the rows are in — otherwise "sort by date created"
       rearranges the catalogue for no visible reason. */
    {
      key: 'created',
      header: 'Created',
      sortable: true,
      cell: (p) => <span className="numeric text-muted">{dates[p.id]?.created || '—'}</span>,
    },
    {
      key: 'edited',
      header: 'Last modified',
      sortable: true,
      cell: (p) => <span className="numeric text-muted">{dates[p.id]?.edited || '—'}</span>,
    },
  ]

  /* Sorting is the server's: the header hands the key back into the URL and the
     page re-queries. A date column that is not the active sort is dropped, and
     the cost pair still depends on the permission.

     `sort` is null inside a variant group, where the rows are in the group's
     own size order and no header may claim otherwise — so there the sort
     affordance comes off rather than pointing at an ordering that would be
     ignored. */
  const shown = columns.filter((c) => {
    if (c.key === 'cost' || c.key === 'gp') return showCost
    if (c.key === 'created' || c.key === 'edited') return sort?.key === c.key
    return true
  })

  return (
    <DataTable
      columns={sort ? shown : shown.map((c) => ({ ...c, sortable: false }))}
      rows={items}
      // Both or neither: DataTable falls back to sorting its own rows the
      // moment one is missing, which on a 50-row page of 4,000 products would
      // answer a different question than the one asked.
      sort={sort ?? undefined}
      onSortChange={
        sort
          ? (next) => router.push(sortHrefs[`${next.key}:${next.direction}`] ?? '/products')
          : undefined
      }
      getRowKey={(p) => p.id}
      selectedKeys={selectedKeys}
      onSelectionChange={onSelectionChange}
      // A variant parent is a collapsed group heading, not a product: it holds
      // no stock and most bulk changes would refuse it anyway. Ticking one and
      // being told afterwards that it was skipped is worse than not offering it.
      isRowSelectable={(p) => !p.hasVariants}
      actions={(p) =>
        p.hasVariants ? (
          <ButtonLink
            href={rowHref(p)}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Show the ${p.variantCount} variants of ${p.description}`}
          >
            <Icons.ChevronRight size={14} />
          </ButtonLink>
        ) : (
          <ButtonLink
            href={`/products/${p.id}`}
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Edit ${p.description}`}
          >
            <Pencil size={14} />
          </ButtonLink>
        )
      }
      actionsOnHover
      empty={empty}
    />
  )
}

import Link from 'next/link'
import { Plus } from '@/components/ui/icons'
import { requireSiteId } from '@/lib/auth'
import { listProducts } from '@/lib/site/products'
import { getCostBasis } from '@/lib/site/lookups'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { formatMoney, formatQty } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PrimaryLink,
  Card,
  EmptyState,
  SearchBar,
  Badge,
  FilterBar,
  FilterChip,
  Pagination,
  TABLE_HEAD_ROW,
  TABLE_TH,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/** Rows per page. The list used to render a flat 100 with no way to reach 101. */
const PAGE_SIZE = 50

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    archived?: string
    low?: string
    department?: string
    page?: string
  }>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams
  const { q, archived, low, department } = params

  const [departments, costBasis] = await Promise.all([
    listDepartments(siteId, true),
    getCostBasis(siteId),
  ])

  // Filtering by a department includes everything beneath it — picking
  // "Fresh Produce" should not hide the products filed under its sub-levels.
  const departmentId = Number(department)
  const filterIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  const page = pageFrom(params.page)
  const { items, total } = await listProducts(siteId, {
    search: q,
    includeArchived: archived === '1',
    belowMinimum: low === '1',
    departmentIds: filterIds,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  const filterLabel = filterIds ? departmentPath(departments, departmentId) : null

  /* Every link on this screen composes onto the current query rather than
     replacing it, so searching no longer drops the department filter and
     paging no longer drops both. */
  const href = hrefBuilder('/products', params)
  /* Any filter change returns to page 1 — page 7 of the old result set is
     rarely a page of the new one, and landing on an empty list reads as "no
     matches" when there are plenty. */
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  return (
    <>
      <PageHeader
        title="Products"
        subtitle={`${total} product${total === 1 ? '' : 's'}${archived === '1' ? ', including archived' : ''}`}
        action={
          <PrimaryLink href="/products/new">
            <Plus size={15} />
            New product
          </PrimaryLink>
        }
      />

      <SearchBar
        action="/products"
        defaultValue={q}
        placeholder="Search description, code or barcode…"
        /* A GET form submits only its own fields, so without these a search
           would silently clear whichever filters were applied. */
        keep={{ archived, low, department }}
      />

      <FilterBar clearHref="/products">
        {filterLabel && (
          <FilterChip
            label="Department"
            value={filterLabel}
            clearHref={filterHref({ department: null })}
          />
        )}
        {low === '1' && (
          <FilterChip label="Stock" value="At or below minimum" clearHref={filterHref({ low: null })} />
        )}
        {archived === '1' && (
          <FilterChip
            label="Archived"
            value="Included"
            clearHref={filterHref({ archived: null })}
          />
        )}
      </FilterBar>

      <div className="flex gap-3 px-6 pb-3 text-xs">
        <Link
          href="/products"
          className={
            !archived && !low && !filterLabel
              ? 'font-medium text-brand'
              : 'text-muted hover:text-ink'
          }
        >
          Active
        </Link>
        <Link
          href={filterHref({ low: low === '1' ? null : '1' })}
          className={low === '1' ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          At or below minimum
        </Link>
        <Link
          href={filterHref({ archived: archived === '1' ? null : '1' })}
          className={archived === '1' ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          Include archived
        </Link>
      </div>

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No products found"
              hint={q ? 'Try a different search.' : 'Create your first product to get started.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Code</th>
                    <th className={TABLE_TH}>Description</th>
                    <th className={TABLE_TH}>Department</th>
                    <th className={`${TABLE_TH} text-right`}>
                      {costBasis === 'last' ? 'Last cost' : 'Avg cost'}
                    </th>
                    <th className={`${TABLE_TH} text-right`}>Price incl.</th>
                    <th className={`${TABLE_TH} text-right`}>GP %</th>
                    <th className={`${TABLE_TH} text-right`}>On hand</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((p) => {
                    // The default structure is the shelf price; fall back to the
                    // first if no structure is flagged default.
                    const price = p.prices.find((x) => x.isDefault) ?? p.prices[0]
                    const belowMin = p.stockOnHand <= p.minStock && p.minStock > 0

                    return (
                      <tr key={p.id} className="hover:bg-surface-2">
                        <td className="px-4 py-2.5">
                          <Link href={`/products/${p.id}`} className="text-brand hover:underline">
                            {p.code}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink">
                          {p.description}
                          {p.isArchived && (
                            <span className="ml-2">
                              <Badge>Archived</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {departmentPath(departments, p.departmentId) || '—'}
                        </td>
                        <td className="numeric px-4 py-2.5 text-right text-muted">
                          {formatMoney(p.cost.effective)}
                        </td>
                        <td className="numeric px-4 py-2.5 text-right text-ink">
                          {price ? formatMoney(price.sellIncl) : '—'}
                        </td>
                        <td
                          className={`numeric px-4 py-2.5 text-right ${
                            price && price.gp < 0 ? 'text-danger' : 'text-muted'
                          }`}
                        >
                          {price ? `${price.gp.toFixed(1)}%` : '—'}
                        </td>
                        <td
                          className={`numeric px-4 py-2.5 text-right ${
                            belowMin ? 'text-warning' : 'text-ink'
                          }`}
                        >
                          {formatQty(p.stockOnHand)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </div>
    </>
  )
}

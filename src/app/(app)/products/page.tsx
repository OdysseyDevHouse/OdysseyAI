import Link from 'next/link'
import { Plus } from '@/components/ui/icons'
import { requireSiteId } from '@/lib/auth'
import { listProducts } from '@/lib/site/products'
import { getCostBasis } from '@/lib/site/lookups'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { formatMoney, formatQty } from '@/lib/decimals'
import { PageHeader, PrimaryLink, Card, EmptyState, SearchBar, Badge, TABLE_HEAD_ROW, TABLE_TH } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; archived?: string; low?: string; department?: string }>
}) {
  const siteId = await requireSiteId()
  const { q, archived, low, department } = await searchParams

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

  const { items, total } = await listProducts(siteId, {
    search: q,
    includeArchived: archived === '1',
    belowMinimum: low === '1',
    departmentIds: filterIds,
    limit: 100,
  })

  const filterLabel = filterIds ? departmentPath(departments, departmentId) : null

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

      <SearchBar action="/products" defaultValue={q} placeholder="Search description, code or barcode…" />

      {filterLabel && (
        <div className="flex items-center gap-2 px-6 pb-1 text-xs">
          <span className="rounded bg-brand/10 px-2 py-1 text-brand">
            Department: {filterLabel}
          </span>
          <Link href="/products" className="text-muted hover:text-ink">
            Clear
          </Link>
        </div>
      )}

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
          href="/products?low=1"
          className={low === '1' ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          At or below minimum
        </Link>
        <Link
          href="/products?archived=1"
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
        </Card>
      </div>
    </>
  )
}

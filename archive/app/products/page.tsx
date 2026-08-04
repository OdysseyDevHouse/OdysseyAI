import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireStoreId } from '@/lib/auth'
import { listProducts } from '@/lib/products'
import { formatMoney, formatQty } from '@/lib/decimals'
import { PageHeader, PrimaryLink, Card, EmptyState, SearchBar, Badge } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    low?: string
    inactive?: string
    supplier?: string
    department?: string
  }>
}) {
  const storeId = await requireStoreId()
  const { q, low, inactive, supplier, department } = await searchParams

  const supplierId = Number(supplier)
  const departmentId = Number(department)

  const { items, total } = await listProducts(storeId, {
    search: q,
    lowStockOnly: low === '1',
    includeInactive: inactive === '1',
    supplierId: Number.isFinite(supplierId) && supplierId > 0 ? supplierId : undefined,
    departmentId: Number.isFinite(departmentId) && departmentId > 0 ? departmentId : undefined,
    limit: 100,
  })

  return (
    <>
      <PageHeader
        title="Products"
        subtitle={`${total} product${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/products/new">
            <Plus size={15} />
            New product
          </PrimaryLink>
        }
      />

      <SearchBar action="/products" defaultValue={q} placeholder="Search name, code or barcode…" />

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
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2.5 font-medium">Code</th>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Department</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                    <th className="px-4 py-2.5 text-right font-medium">Price</th>
                    <th className="px-4 py-2.5 text-right font-medium">Margin</th>
                    <th className="px-4 py-2.5 text-right font-medium">Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((p) => {
                    const lowOnStock = p.trackStock && p.stockOnHand <= p.reorderLevel
                    return (
                      <tr key={p.id} className="hover:bg-surface-2">
                        <td className="px-4 py-2.5">
                          <Link href={`/products/${p.id}`} className="text-brand hover:underline">
                            {p.sku}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink">
                          {p.name}
                          {!p.isActive && (
                            <span className="ml-2">
                              <Badge>Inactive</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted">{p.departmentName ?? '—'}</td>
                        <td className="numeric px-4 py-2.5 text-right text-muted">
                          {formatMoney(p.costPrice)}
                        </td>
                        <td className="numeric px-4 py-2.5 text-right text-ink">
                          {formatMoney(p.sellingPrice)}
                        </td>
                        <td
                          className={`numeric px-4 py-2.5 text-right ${
                            p.marginPercent < 0 ? 'text-danger' : 'text-muted'
                          }`}
                        >
                          {p.marginPercent.toFixed(1)}%
                        </td>
                        <td className="numeric px-4 py-2.5 text-right">
                          {p.trackStock ? (
                            <span className={lowOnStock ? 'text-warning' : 'text-ink'}>
                              {formatQty(p.stockOnHand)}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
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

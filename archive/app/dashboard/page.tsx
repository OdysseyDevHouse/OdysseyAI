import Link from 'next/link'
import { requireStoreId } from '@/lib/auth'
import { listProducts } from '@/lib/products'
import { listCustomers } from '@/lib/customers'
import { listSuppliers } from '@/lib/suppliers'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, StatTile, Card, EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const storeId = await requireStoreId()

  const [products, lowStock, customers, onHold, suppliers] = await Promise.all([
    listProducts(storeId, { limit: 1 }),
    listProducts(storeId, { lowStockOnly: true, limit: 10 }),
    listCustomers(storeId, { limit: 1 }),
    listCustomers(storeId, { withBalanceOnly: true, limit: 10 }),
    listSuppliers(storeId, { limit: 1 }),
  ])

  const owed = onHold.items.reduce((sum, c) => sum + c.balance, 0)

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Everything at a glance for this store." />

      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Active products" value={String(products.total)} />
        <StatTile
          label="Low stock"
          value={String(lowStock.total)}
          hint="At or below reorder level"
          tone={lowStock.total > 0 ? 'warning' : 'default'}
        />
        <StatTile label="Active customers" value={String(customers.total)} />
        <StatTile label="Suppliers" value={String(suppliers.total)} />
      </div>

      <div className="grid gap-4 px-6 pb-6 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Needs reordering</h2>
            <Link href="/products?low=1" className="text-xs text-brand hover:underline">
              View all
            </Link>
          </div>
          {lowStock.items.length === 0 ? (
            <EmptyState title="Nothing to reorder" hint="All tracked stock is above its level." />
          ) : (
            <ul className="divide-y divide-border">
              {lowStock.items.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link href={`/products/${p.id}`} className="min-w-0 hover:underline">
                    <div className="truncate text-sm text-ink">{p.name}</div>
                    <div className="truncate text-xs text-muted">{p.sku}</div>
                  </Link>
                  <div className="numeric shrink-0 text-right">
                    <div className="text-sm text-warning">{p.stockOnHand}</div>
                    <div className="text-xs text-muted">of {p.reorderLevel}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Customer balances</h2>
            <Link href="/customers?balance=1" className="text-xs text-brand hover:underline">
              View all
            </Link>
          </div>
          {onHold.items.length === 0 ? (
            <EmptyState title="No outstanding balances" />
          ) : (
            <>
              <ul className="divide-y divide-border">
                {onHold.items.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <Link href={`/customers/${c.id}`} className="min-w-0 hover:underline">
                      <div className="truncate text-sm text-ink">{c.name}</div>
                      <div className="truncate text-xs text-muted">{c.code}</div>
                    </Link>
                    <div
                      className={`numeric shrink-0 text-sm ${c.overLimit ? 'text-danger' : 'text-ink'}`}
                    >
                      {formatMoney(c.balance)}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex justify-between border-t border-border px-4 py-2.5 text-sm">
                <span className="font-medium text-muted">Total shown</span>
                <span className="numeric font-semibold text-ink">{formatMoney(owed)}</span>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  )
}

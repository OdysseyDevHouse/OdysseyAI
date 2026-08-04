import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireStoreId } from '@/lib/auth'
import { listSuppliers } from '@/lib/suppliers'
import { PageHeader, PrimaryLink, Card, EmptyState, SearchBar, Badge } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; inactive?: string }>
}) {
  const storeId = await requireStoreId()
  const { q, inactive } = await searchParams

  const { items, total } = await listSuppliers(storeId, {
    search: q,
    includeInactive: inactive === '1',
    limit: 100,
  })

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle={`${total} supplier${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/suppliers/new">
            <Plus size={15} />
            New supplier
          </PrimaryLink>
        }
      />

      <SearchBar action="/suppliers" defaultValue={q} placeholder="Search name, code or email…" />

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No suppliers found"
              hint={q ? 'Try a different search.' : 'Add your first supplier to get started.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2.5 font-medium">Code</th>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-4 py-2.5 text-right font-medium">Terms</th>
                    <th className="px-4 py-2.5 text-right font-medium">Products</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((s) => (
                    <tr key={s.id} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        <Link href={`/suppliers/${s.id}`} className="text-brand hover:underline">
                          {s.code}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ink">{s.name}</td>
                      <td className="px-4 py-2.5 text-muted">
                        {s.contactName ?? s.email ?? s.phone ?? '—'}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">
                        {s.paymentTermsDays}d
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">
                        {s.productCount}
                      </td>
                      <td className="px-4 py-2.5">
                        {s.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

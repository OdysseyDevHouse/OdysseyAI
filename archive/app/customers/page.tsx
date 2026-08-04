import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireStoreId } from '@/lib/auth'
import { listCustomers } from '@/lib/customers'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PrimaryLink, Card, EmptyState, SearchBar, Badge } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; balance?: string; inactive?: string }>
}) {
  const storeId = await requireStoreId()
  const { q, balance, inactive } = await searchParams

  const { items, total } = await listCustomers(storeId, {
    search: q,
    withBalanceOnly: balance === '1',
    includeInactive: inactive === '1',
    limit: 100,
  })

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={`${total} customer${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/customers/new">
            <Plus size={15} />
            New customer
          </PrimaryLink>
        }
      />

      <SearchBar
        action="/customers"
        defaultValue={q}
        placeholder="Search name, code, email or phone…"
      />

      <div className="px-6 pb-6">
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No customers found"
              hint={q ? 'Try a different search.' : 'Add your first customer to get started.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-4 py-2.5 font-medium">Code</th>
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-4 py-2.5 text-right font-medium">Credit limit</th>
                    <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        <Link href={`/customers/${c.id}`} className="text-brand hover:underline">
                          {c.code}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ink">{c.name}</td>
                      <td className="px-4 py-2.5 text-muted">{c.email ?? c.phone ?? '—'}</td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">
                        {formatMoney(c.creditLimit)}
                      </td>
                      <td
                        className={`numeric px-4 py-2.5 text-right ${
                          c.overLimit ? 'text-danger' : 'text-ink'
                        }`}
                      >
                        {formatMoney(c.balance)}
                      </td>
                      <td className="px-4 py-2.5">
                        {!c.isActive ? (
                          <Badge>Inactive</Badge>
                        ) : c.onHold ? (
                          <Badge tone="danger">On hold</Badge>
                        ) : c.overLimit ? (
                          <Badge tone="warning">Over limit</Badge>
                        ) : (
                          <Badge tone="positive">Good</Badge>
                        )}
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

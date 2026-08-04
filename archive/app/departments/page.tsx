import Link from 'next/link'
import { requireStoreId } from '@/lib/auth'
import { listDepartments } from '@/lib/lookups'
import { PageHeader, Card, EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DepartmentsPage() {
  const storeId = await requireStoreId()
  const departments = await listDepartments(storeId, true)

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Product groupings used for reporting and POS tiles."
      />

      <div className="p-6">
        <Card>
          {departments.length === 0 ? (
            <EmptyState
              title="No departments yet"
              hint="Departments are seeded per store — add them under Settings."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">Code</th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 text-right font-medium">Products</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {departments.map((d) => (
                  <tr key={d.id} className="hover:bg-surface-2">
                    <td className="px-4 py-2.5 text-muted">{d.code}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 text-ink">
                        {d.color && (
                          <span
                            aria-hidden
                            className="size-2.5 rounded-full"
                            style={{ background: d.color }}
                          />
                        )}
                        {d.name}
                      </span>
                    </td>
                    <td className="numeric px-4 py-2.5 text-right">
                      <Link
                        href={`/products?department=${d.id}`}
                        className="text-brand hover:underline"
                      >
                        {d.productCount}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  )
}

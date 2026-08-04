import Link from 'next/link'
import { Plus, StatusSuccess as CheckCircle2, CornerDownRight } from '@/components/ui/icons'
import { requireSiteId } from '@/lib/auth'
import { listDepartments, flattenTree } from '@/lib/site/departments'
import { PageHeader, PrimaryLink, Card, EmptyState, Badge, TABLE_HEAD_ROW, TABLE_TH } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; deleted?: string }>
}) {
  const siteId = await requireSiteId()
  const { saved, deleted } = await searchParams

  // Inactive rows are shown too — hiding them here would make a department that
  // still holds products look as though it had vanished.
  const departments = await listDepartments(siteId, true)
  const rows = flattenTree(departments)

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle={`${departments.length} department${departments.length === 1 ? '' : 's'} · nest as deep as you like`}
        action={
          <PrimaryLink href="/departments/new">
            <Plus size={15} />
            New department
          </PrimaryLink>
        }
      />

      {(saved || deleted) && (
        <div className="px-6 pt-4">
          <p className="flex items-center gap-2 rounded-md bg-positive/10 px-3 py-2 text-sm text-positive">
            <CheckCircle2 size={15} />
            {saved ? 'Department saved.' : 'Department deleted.'}
          </p>
        </div>
      )}

      <div className="p-6">
        <Card>
          {rows.length === 0 ? (
            <EmptyState
              title="No departments yet"
              hint="Create a top-level department, then add sub-departments beneath it."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Department</th>
                    <th className={TABLE_TH}>Code</th>
                    <th className={`${TABLE_TH} text-right`}>Products</th>
                    <th className={`${TABLE_TH} text-right`}>Sub-departments</th>
                    <th className={TABLE_TH}>Status</th>
                    <th className={`${TABLE_TH} text-right`}></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(({ department: d, depth }) => (
                    <tr key={d.id} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        {/* Indentation carries the hierarchy; padding rather
                            than nested tables keeps the columns aligned. */}
                        <span
                          className="flex items-center gap-1.5"
                          style={{ paddingLeft: `${depth * 20}px` }}
                        >
                          {depth > 0 && (
                            <CornerDownRight size={13} className="shrink-0 text-muted opacity-60" />
                          )}
                          {d.color && (
                            <span
                              aria-hidden
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ background: d.color }}
                            />
                          )}
                          <Link
                            href={`/departments/${d.id}`}
                            className="text-brand hover:underline"
                          >
                            {d.name}
                          </Link>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted">{d.code ?? '—'}</td>
                      <td className="numeric px-4 py-2.5 text-right">
                        {d.productCount > 0 ? (
                          <Link
                            href={`/products?department=${d.id}`}
                            className="text-brand hover:underline"
                          >
                            {d.productCount}
                          </Link>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">{d.childCount}</td>
                      <td className="px-4 py-2.5">
                        {d.isActive ? (
                          <Badge tone="positive">Active</Badge>
                        ) : (
                          <Badge>Inactive</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/departments/new?parent=${d.id}`}
                          className="text-xs text-muted hover:text-brand"
                        >
                          Add sub
                        </Link>
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

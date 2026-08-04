import Link from 'next/link'
import { notFound } from 'next/navigation'
import { StatusError as AlertCircle, Trash as Trash2, Plus } from '@/components/ui/icons'
import { requireSiteId } from '@/lib/auth'
import {
  listDepartments,
  getDepartment,
  flattenTree,
  departmentPath,
  descendantIds,
} from '@/lib/site/departments'
import { Button, PageHeader, Card } from '@/components/ui'
import DepartmentForm from '../DepartmentForm'
import { deleteDepartmentAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditDepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { id } = await params
  const { error } = await searchParams
  const departmentId = Number(id)
  if (!Number.isFinite(departmentId) || departmentId <= 0) notFound()

  const siteId = await requireSiteId()
  const [department, departments] = await Promise.all([
    getDepartment(siteId, departmentId),
    listDepartments(siteId, true),
  ])
  if (!department) notFound()

  // A department cannot be moved inside itself or its own descendants — that
  // would cut the branch off from the tree entirely. The server re-checks this;
  // leaving them out of the select just stops it being offered.
  const forbidden = descendantIds(departments, departmentId)
  const parentOptions = flattenTree(departments)
    .filter(({ department: d }) => !forbidden.has(d.id))
    .map(({ department: d }) => ({
      id: d.id,
      label: departmentPath(departments, d.id),
    }))

  const blocked = department.childCount > 0 || department.productCount > 0

  return (
    <>
      <PageHeader
        title={department.name}
        subtitle={departmentPath(departments, department.id)}
        backHref="/departments"
        action={
          <div className="flex items-center gap-2">
            <Link
              href={`/departments/new?parent=${department.id}`}
              className="flex items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-ink"
            >
              <Plus size={15} />
              Add sub-department
            </Link>

            <form action={deleteDepartmentAction}>
              <input type="hidden" name="id" value={department.id} />
              <Button
                type="submit"
                variant="danger-ghost"
                disabled={blocked}
                title={
                  blocked
                    ? 'Still has sub-departments or products assigned'
                    : 'Delete this department'
                }
              >
                <Trash2 size={15} />
                Delete
              </Button>
            </form>
          </div>
        }
      />

      {error && (
        <div className="px-6 pt-4">
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            {error}
          </p>
        </div>
      )}

      <div className="p-6">
        <Card>
          <DepartmentForm
            department={department}
            parentOptions={parentOptions}
            defaultParentId={department.parentId}
          />
        </Card>
      </div>
    </>
  )
}

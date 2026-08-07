import { notFound } from 'next/navigation'
import { Plus } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import {
  listDepartments,
  getDepartment,
  flattenTree,
  departmentPath,
  descendantIds,
} from '@/lib/site/departments'
import { ButtonLink, Callout, Card, CardHeader, PageBody, PageHeader } from '@/components/ui'
import DepartmentForm from '../DepartmentForm'
import DeleteDepartmentButton from '../DeleteDepartmentButton'

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

  // A hidden menu entry is not a boundary — this URL is typeable.

  const { siteId } = await requireCapability('products.edit')
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
            <ButtonLink href={`/departments/new?parent=${department.id}`} variant="secondary">
              <Plus size={15} />
              Add sub-department
            </ButtonLink>

            <DeleteDepartmentButton
              id={department.id}
              name={department.name}
              blocked={blocked}
            />
          </div>
        }
      />

      <PageBody>
        {error && <Callout tone="danger">{error}</Callout>}

        <Card>
          <CardHeader title="Department" description="Name, position in the tree and presentation." />
          <DepartmentForm
            department={department}
            parentOptions={parentOptions}
            defaultParentId={department.parentId}
          />
        </Card>
      </PageBody>
    </>
  )
}

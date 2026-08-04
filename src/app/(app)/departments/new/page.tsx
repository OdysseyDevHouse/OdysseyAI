import { requireSiteId } from '@/lib/auth'
import { listDepartments, flattenTree, departmentPath } from '@/lib/site/departments'
import { PageHeader, Card } from '@/components/ui'
import DepartmentForm from '../DepartmentForm'

export const dynamic = 'force-dynamic'

export default async function NewDepartmentPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>
}) {
  const siteId = await requireSiteId()
  const { parent } = await searchParams

  const departments = await listDepartments(siteId, true)

  const parentId = Number(parent)
  const defaultParentId = Number.isFinite(parentId) && parentId > 0 ? parentId : null

  // Full path as the label, so two "Fruit" nodes under different majors are
  // still telling apart in a flat select.
  const parentOptions = flattenTree(departments).map(({ department }) => ({
    id: department.id,
    label: departmentPath(departments, department.id),
  }))

  const under = defaultParentId ? departmentPath(departments, defaultParentId) : null

  return (
    <>
      <PageHeader
        title="New department"
        subtitle={under ? `Under ${under}` : 'Top level'}
      />
      <div className="p-6">
        <Card>
          <DepartmentForm
            department={null}
            parentOptions={parentOptions}
            defaultParentId={defaultParentId}
          />
        </Card>
      </div>
    </>
  )
}

import { requireCapability } from '@/lib/auth'
import { listDepartments, flattenTree, departmentPath } from '@/lib/site/departments'
import { Card, CardHeader, PageBody, PageHeader } from '@/components/ui'
import DepartmentForm from '../DepartmentForm'

export const dynamic = 'force-dynamic'

export default async function NewDepartmentPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.edit')
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
        backHref="/departments"
        title="New department"
        subtitle={under ? `Under ${under}` : 'Top level'}
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Department"
            description="Name, position in the tree and presentation."
          />
          <DepartmentForm
            department={null}
            parentOptions={parentOptions}
            defaultParentId={defaultParentId}
            // A department being created has neither picture yet.
            pictures={{ pos: null, online: null }}
          />
        </Card>
      </PageBody>
    </>
  )
}

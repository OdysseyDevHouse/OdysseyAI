import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listDepartments } from '@/lib/site/departments'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import { DepartmentsClient } from './DepartmentsClient'

export const dynamic = 'force-dynamic'

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; deleted?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('products.view')
  const canEdit = can(capabilities, 'products.edit')
  const { saved, deleted } = await searchParams

  // Inactive rows are shown too — hiding them here would make a department that
  // still holds products look as though it had vanished, and the list now
  // offers the switch that reactivates one.
  const departments = await listDepartments(siteId, true)

  const topLevel = departments.filter((d) => d.parentId === null).length

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle={`${topLevel} top-level · ${departments.length} in total · nest as deep as you like`}
      />

      <PageBody>
        {(saved || deleted) && (
          <Callout tone="success" title={saved ? 'Department saved.' : 'Department deleted.'} />
        )}

        <DepartmentsClient departments={departments} canEdit={canEdit} />
      </PageBody>
    </>
  )
}

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
import { storefrontImagesByIds } from '@/lib/site/storefrontImages'
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

  /*
   * The two pictures, in one query for both. An id that no longer resolves is
   * simply absent from the map — a picture deleted from the library is not an
   * error here, it is a department that falls back to its colour and initial.
   */
  const pictures = await storefrontImagesByIds(
    siteId,
    [department.posImageId, department.onlineImageId].filter((id): id is number => id !== null),
  )

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
      {/*
        The code rides on the subtitle rather than sitting in the form.

        It is allocated, not typed — see nextDepartmentCode — so it is a fact
        ABOUT this record like its path, not a decision the page is asking for.
        Among the inputs it read as one more blank to fill in; here it reads as
        the reference a shop quotes back off a report.
      */}
      <PageHeader
        title={department.name}
        subtitle={[departmentPath(departments, department.id), department.code]
          .filter(Boolean)
          .join(' · ')}
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
            pictures={{
              pos: department.posImageId ? pictures.get(department.posImageId) ?? null : null,
              online: department.onlineImageId
                ? pictures.get(department.onlineImageId) ?? null
                : null,
            }}
          />
        </Card>
      </PageBody>
    </>
  )
}

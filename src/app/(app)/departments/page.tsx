import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listDepartments } from '@/lib/site/departments'
import { storefrontImagesByIds } from '@/lib/site/storefrontImages'
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

  /*
   * Which departments actually have a till picture, resolved in ONE query for
   * the whole tree rather than a request per row.
   *
   * Only the ids that resolve are shipped: a picture deleted from the library
   * leaves the department pointing at nothing, and an <img> onto a 404 is a
   * broken-image glyph where the initials tile should be. Sending the set of
   * LIVE ids lets the row decide between a picture and its fallback without
   * having to discover the failure in the browser.
   */
  const pictures = await storefrontImagesByIds(
    siteId,
    departments.map((d) => d.posImageId).filter((id): id is number => id !== null),
  )
  const withPicture = [...pictures.keys()]

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

        <DepartmentsClient
          departments={departments}
          pictureIds={withPicture}
          canEdit={canEdit}
        />
      </PageBody>
    </>
  )
}

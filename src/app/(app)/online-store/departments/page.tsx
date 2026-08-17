import { requireModuleCapability } from '@/lib/auth'
import { getOnlineSettings, getPublishCounts, listDepartmentVisibility } from '@/lib/site/onlineStore'
import { PageHeader, PageBody } from '@/components/ui'
import DepartmentTree from './DepartmentTree'

/**
 * Which departments the online store shows.
 *
 * VISIBILITY ONLY, deliberately. Renaming, adding and deleting departments all
 * live on the Inventory department screen, which owns those columns and shares
 * them with the till. A second editor here would mean two screens writing the
 * same rows with different validation.
 */

export const dynamic = 'force-dynamic'

export default async function OnlineDepartmentsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [departments, counts, settings] = await Promise.all([
    listDepartmentVisibility(siteId),
    getPublishCounts(siteId),
    getOnlineSettings(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="What your online store shows"
      />
      <PageBody>
        <DepartmentTree
          departments={departments}
          counts={counts}
          publishMode={settings.publishMode}
        />
      </PageBody>
    </>
  )
}

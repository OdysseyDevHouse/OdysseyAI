import { requireCapability } from '@/lib/auth'
import { getOnlineSettings, listDepartmentVisibility } from '@/lib/site/onlineStore'
import { listPages } from '@/lib/site/storefrontPages'
import { listStorefrontImages } from '@/lib/site/storefrontImages'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { PageHeader, PageBody } from '@/components/ui'
import PagesList from './PagesList'

/**
 * The shop's pages.
 *
 * Everything about a page EXCEPT its sections — the builder owns those. See
 * PagesList for why the two are separate screens.
 */

export const dynamic = 'force-dynamic'

export default async function PagesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')

  const [pages, settings, departments, token, images] = await Promise.all([
    listPages(siteId),
    getOnlineSettings(siteId),
    listDepartmentVisibility(siteId),
    createPublicStoreToken(siteId),
    // The whole library, for the share-image picker. Small by construction —
    // MAX_STOREFRONT_IMAGES caps it at 40.
    listStorefrontImages(siteId),
  ])

  /*
   * Departments still worth offering a page to.
   *
   * Two filters, for two different reasons. Only PUBLISHED departments, since
   * a page above products nobody can see is decoration on an empty room. And
   * only those without one already — uq_page_department would refuse the
   * second anyway, and an option that always errors is not an option.
   */
  const taken = new Set(pages.filter((p) => p.departmentId).map((p) => p.departmentId))
  const available = departments
    .filter((d) => (d.showOnline || d.publishedByParent) && !taken.has(d.id))
    .map((d) => ({ id: d.id, name: d.name }))

  return (
    <>
      <PageHeader
        title="Pages"
        subtitle="The pages on your shop, and who can reach them"
      />
      <PageBody>
        <PagesList
          pages={pages}
          departments={available}
          storePath={`/store/${token}`}
          storeOpen={settings.isEnabled}
          images={images}
        />
      </PageBody>
    </>
  )
}

import { requireModuleCapability } from '@/lib/auth'
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
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

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
   *
   * Sub-departments are offered on exactly the same terms as top-level ones:
   * a shop with "Wine › Red" and "Wine › White" may well want each arranged
   * differently, and `publishedByParent` is what makes a child published by its
   * parent's tick still eligible.
   */
  const taken = new Set(pages.filter((p) => p.departmentId).map((p) => p.departmentId))

  /*
   * Each department's full path — "Wine › Red" rather than "Red".
   *
   * A flat list of leaf names is unusable on a real tree: "Red" and "White"
   * appear under Wine, under Paint and under Roses, and the picker gives no way
   * to tell them apart. Built here rather than in the client because the parent
   * chain is already in hand.
   */
  const nameById = new Map(departments.map((d) => [d.id, d]))
  const pathOf = (id: number): string => {
    const parts: string[] = []
    const seen = new Set<number>()
    let at: number | null = id
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const dept = nameById.get(at)
      if (!dept) break
      parts.unshift(dept.name)
      at = dept.parentId
    }
    return parts.join(' › ')
  }

  const available = departments
    .filter((d) => (d.showOnline || d.publishedByParent) && !taken.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, path: pathOf(d.id), depth: pathOf(d.id).split(' › ').length - 1 }))
    // Ancestors before descendants, so the list reads as the tree it is.
    .sort((a, b) => a.path.localeCompare(b.path))

  // The path for every department that HAS a page, so each row can say which
  // one it belongs to without the reader guessing from a bare leaf name.
  const departmentPaths: Record<number, string> = {}
  for (const p of pages) if (p.departmentId) departmentPaths[p.departmentId] = pathOf(p.departmentId)

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
          departmentPaths={departmentPaths}
          storePath={`/store/${token}`}
          storeOpen={settings.isEnabled}
          images={images}
        />
      </PageBody>
    </>
  )
}

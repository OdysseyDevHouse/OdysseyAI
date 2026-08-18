import { PageHeader } from '@/components/ui'
import { requireModuleCapability } from '@/lib/auth'
import { listDepartmentVisibility } from '@/lib/site/onlineStore'
import { listListingPresets, shopListingPreset } from '@/lib/site/listingPresets'
import ListingClient, { type DepartmentRow } from './ListingClient'

export const dynamic = 'force-dynamic'

/**
 * How a shop arranges its product listings.
 *
 * Its own screen rather than a drawer on the Departments page: that screen
 * answers "which departments does the public see", which is a publishing
 * decision, and this one answers "how do they look", which is a design one. A
 * shop owner opening Departments to hide an aisle should not have to scroll
 * past six layout controls to do it.
 */
export default async function OnlineListingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [shop, presets, departments] = await Promise.all([
    shopListingPreset(siteId),
    // Every configured row in one query rather than one per department: the
    // screen lists every aisle with its effective settings, and doing that a
    // row at a time is a query per aisle for a table holding a handful.
    listListingPresets(siteId),
    listDepartmentVisibility(siteId),
  ])

  /*
   * Only the departments a shopper can reach.
   *
   * Arranging a listing nobody can open is a control with no effect, and the
   * shop already has a screen for deciding which departments are published.
   */
  const rows: DepartmentRow[] = departments
    .filter((d) => d.showOnline)
    .map((d) => ({
      id: d.id,
      name: d.name,
      hasOwn: presets.has(d.id),
      preset: presets.get(d.id) ?? shop,
    }))

  return (
    <>
      <PageHeader title="Listings" subtitle="How your products are arranged" />
      <ListingClient shop={shop} departments={rows} />
    </>
  )
}

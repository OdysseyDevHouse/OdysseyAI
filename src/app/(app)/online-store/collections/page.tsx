import { PageHeader } from '@/components/ui'
import { requireModuleCapability } from '@/lib/auth'
import { listCollections, collectionPicks } from '@/lib/site/storefrontCollections'
import { listDepartmentVisibility } from '@/lib/site/onlineStore'
import { publishedDepartments, storefrontContext } from '@/lib/site/storefront'
import { siteQuery } from '@/lib/siteDb'
import CollectionsClient, { type CollectionRow } from './CollectionsClient'

export const dynamic = 'force-dynamic'

/**
 * A shop's collections.
 *
 * ── ITS OWN SCREEN, NOT A TAB ON DEPARTMENTS ─────────────────────────────
 *
 * The whole point of a collection is that it is NOT a department: departments
 * are the inventory tree the till and the stockroom share, and collections cut
 * across them. Filing the two together on one screen would be the interface
 * arguing the opposite of what the data says.
 */
export default async function CollectionsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [collections, departments, pickerDepartments, brands] = await Promise.all([
    listCollections(siteId),
    listDepartmentVisibility(siteId),
    // The picker filters by department and wants the storefront shape, not the
    // admin one. Null when the shop is closed, which is a picker with no filter
    // rather than a screen that refuses to load.
    storefrontContext(siteId).then((c) => (c ? publishedDepartments(c) : [])),
    // The brands a rule can name. Distinct rather than every product's, because
    // this fills a dropdown.
    siteQuery<{ name: string }>(
      siteId,
      `SELECT DISTINCT b.name FROM brands b
         JOIN products p ON p.brand_id = b.id
        WHERE b.name <> '' ORDER BY b.name LIMIT 200`,
    ),
  ])

  /*
   * The picks travel with the collection that holds them.
   *
   * One query per manual collection rather than a join: a shop has a handful,
   * only some are manual, and the alternative is fanning one result set back
   * out into groups on the way to the client.
   */
  const rows: CollectionRow[] = await Promise.all(
    collections.map(async (c) => ({
      ...c,
      picks: c.rule === 'manual' ? await collectionPicks(siteId, c.id) : [],
    })),
  )

  return (
    <>
      <PageHeader title="Collections" subtitle="Your own way of grouping what you sell" />
      <CollectionsClient
        collections={rows}
        departments={departments.filter((d) => d.showOnline).map((d) => ({ id: d.id, name: d.name }))}
        pickerDepartments={pickerDepartments}
        brands={brands.map((b) => b.name)}
      />
    </>
  )
}

import { requireSite, requireModuleCapability } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import { requireSession } from '@/lib/auth'
import { groupForSite, membersOfGroup, storeContents } from '@/lib/storeGroups'
import { branchPinsFor } from '@/lib/control/storeBranches'
import { PageHeader, PageBody } from '@/components/ui'
import LinkedStoresSetup from './LinkedStoresSetup'

export const dynamic = 'force-dynamic'

export default async function LinkedStoresPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireModuleCapability('multi_branch', 'setup.edit')
  const site = await requireSite()
  const session = await requireSession()

  const group = await groupForSite(site.id)
  const members = group ? await membersOfGroup(group.id) : []

  // Read each store's own database so the screen can block "share products" on
  // a store that already holds some, and say exactly how many.
  const contents = Object.fromEntries(
    await Promise.all(
      members.map(async (m) => [m.siteId, m.hasDatabase ? await storeContents(m.siteId) : null]),
    ),
  )

  // Only stores this user may already open can be linked — the picker must not
  // become a way to discover or reach sites they have no access to.
  const available = (await listSitesForUser(session.userId)).filter(
    (s) => !members.some((m) => m.siteId === s.id),
  )

  // One control-database query for every branch's pin, rather than opening each
  // store's own database — the whole reason cp2_store_branches exists.
  const pins = await branchPinsFor(members.map((m) => m.siteId))
  const primary = members.find((m) => m.siteId === group?.primarySiteId) ?? null

  return (
    <>
      <PageHeader
        title="Linked stores"
        subtitle="Other Odyssey stores that share products with this one. Each store keeps its own database; linking decides what a product edit copies across."
      />
      <PageBody>
        <LinkedStoresSetup
          currentSiteId={site.id}
          currentSiteName={site.displayName}
          groupName={group?.name ?? null}
          members={members}
          contents={contents}
          available={available.map((s) => ({
            id: s.id,
            code: s.code,
            name: s.displayName,
          }))}
          groupStorefront={
            group
              ? {
                  enabled: group.onlineGroupMode,
                  primaryName: primary?.displayName ?? null,
                  branches: pins.map((p) => ({
                    siteId: p.siteId,
                    displayName: p.displayName,
                    latitude: p.latitude,
                    longitude: p.longitude,
                    acceptsOnline: p.acceptsOnline,
                    // Serialised here: a Date crossing into a client component
                    // arrives as a string anyway, so the boundary is made
                    // explicit rather than left to chance.
                    syncedAt: p.syncedAt ? p.syncedAt.toISOString() : null,
                  })),
                }
              : null
          }
        />
      </PageBody>
    </>
  )
}

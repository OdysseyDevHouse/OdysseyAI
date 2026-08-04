import { requireSite } from '@/lib/auth'
import { listSitesForUser } from '@/lib/sites'
import { requireSession } from '@/lib/auth'
import { groupForSite, membersOfGroup, storeContents } from '@/lib/storeGroups'
import { PageHeader, PageBody } from '@/components/ui'
import LinkedStoresSetup from './LinkedStoresSetup'

export const dynamic = 'force-dynamic'

export default async function LinkedStoresPage() {
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
        />
      </PageBody>
    </>
  )
}

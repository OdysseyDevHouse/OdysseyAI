import { requireCapability } from '@/lib/auth'
import {
  getOnlineSettings,
  getPublishCounts,
  listDeliveryZones,
} from '@/lib/site/onlineStore'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { PageHeader, PageBody } from '@/components/ui'
import SetupForm from './SetupForm'

/**
 * Online store — Setup.
 *
 * What the shop sells online, how customers get their order, and the link to
 * share. The store is CLOSED until every check on this screen passes, which is
 * what keeps a half-configured storefront from ever being public.
 */

export const dynamic = 'force-dynamic'

export default async function OnlineStoreSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')

  const [settings, counts, zones, token] = await Promise.all([
    getOnlineSettings(siteId),
    getPublishCounts(siteId),
    listDeliveryZones(siteId),
    // Deterministic, so the link printed on a slip last month still resolves.
    createPublicStoreToken(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Online store"
        subtitle="Let customers order from you online, for collection or delivery"
      />
      <PageBody>
        <SetupForm
          settings={settings}
          counts={counts}
          zones={zones}
          storePath={`/store/${token}`}
        />
      </PageBody>
    </>
  )
}

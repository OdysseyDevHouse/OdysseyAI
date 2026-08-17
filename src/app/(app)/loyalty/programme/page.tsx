import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getLoyaltySettings, loyaltyTenderIds } from '@/lib/site/loyalty'
import { PageHeader, PageBody, LinkTabs, Callout } from '@/components/ui'
import { ProgrammeClient } from './ProgrammeClient'
import { LOYALTY_TABS } from '../tabs'

export const dynamic = 'force-dynamic'

export default async function ProgrammePage() {
  const { siteId, capabilities } = await requireModuleCapability('loyalty', 'loyalty.view')

  const [settings, tenders] = await Promise.all([
    getLoyaltySettings(siteId),
    loyaltyTenderIds(siteId),
  ])

  // A running programme with no active tender can earn but never spend, which
  // looks like a bug to a cashier and is invisible from this screen otherwise.
  const missingTender = settings.enabled && !tenders.points

  return (
    <>
      <PageHeader
        title="Loyalty"
        subtitle="What a rand earns, what a point is worth, and how both expire."
      />
      <PageBody>
        <LinkTabs items={LOYALTY_TABS} value="programme" />

        {missingTender && (
          <Callout tone="warning">
            The programme is running but the <strong>Loyalty points</strong> tender is switched off,
            so customers can earn and never spend. Turn it on under Setup → Tender types.
          </Callout>
        )}

        <ProgrammeClient initial={settings} canEdit={can(capabilities, 'loyalty.edit')} />
      </PageBody>
    </>
  )
}

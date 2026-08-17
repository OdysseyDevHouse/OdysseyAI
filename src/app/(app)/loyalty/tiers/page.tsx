import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listTiers } from '@/lib/site/loyalty'
import { PageHeader, PageBody, LinkTabs } from '@/components/ui'
import { TiersClient } from './TiersClient'
import { LOYALTY_TABS } from '../tabs'

export const dynamic = 'force-dynamic'

export default async function TiersPage() {
  const { siteId, capabilities } = await requireModuleCapability('loyalty', 'loyalty.view')
  const tiers = await listTiers(siteId)

  return (
    <>
      <PageHeader title="Loyalty" subtitle="The tiers members climb, and what each one is worth." />
      <PageBody>
        <LinkTabs items={LOYALTY_TABS} value="tiers" />
        <TiersClient initial={tiers} canEdit={can(capabilities, 'loyalty.edit')} />
      </PageBody>
    </>
  )
}

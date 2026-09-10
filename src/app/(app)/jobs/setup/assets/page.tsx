import { requireModuleCapability } from '@/lib/auth'
import { listAssetTypes } from '@/lib/site/jobAssets'
import { PageHeader, PageBody } from '@/components/ui'
import AssetTypesPanel from './AssetTypesPanel'

export const dynamic = 'force-dynamic'

/**
 * The kinds of customer equipment this business services.
 *
 * Kinds, not the equipment itself — the machines belong to customers and live on
 * /jobs/equipment. What is decided here is what a kind IS: what its identifier is
 * called (a vehicle has a VIN, a meter has an asset tag), and how often it is due.
 *
 * Tolerant on the read: a site without migration 115 gets the screen and an empty
 * list rather than a 500.
 */
export default async function JobAssetsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const assetTypes = await listAssetTypes(siteId, true).catch(() => [])

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="The equipment you service, and what to record on each one."
      />
      <PageBody>
        <AssetTypesPanel types={assetTypes} />
      </PageBody>
    </>
  )
}

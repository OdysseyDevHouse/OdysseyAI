import { requireCapability } from '@/lib/auth'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { PageHeader, PageBody } from '@/components/ui'
import TenderTypesClient from './TenderTypesClient'

export const dynamic = 'force-dynamic'

export default async function TenderTypesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  // Inactive ones included: the whole point of this screen is turning them back on.
  const tenders = await listTenderTypes(siteId, true)

  return (
    <>
      <PageHeader
        title="Tender types"
        subtitle="How sales are paid for. Some stores have four, some have ten."
      />
      <PageBody>
        <TenderTypesClient tenders={tenders} />
      </PageBody>
    </>
  )
}

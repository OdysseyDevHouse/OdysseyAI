import { requireCapability } from '@/lib/auth'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { listFieldDefs } from '@/lib/site/customFields'
import { PageHeader, PageBody } from '@/components/ui'
import TenderTypesClient from './TenderTypesClient'

export const dynamic = 'force-dynamic'

export default async function TenderTypesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  // Inactive ones included: the whole point of this screen is turning them back on.
  const tenders = await listTenderTypes(siteId, true)

  /*
   * How many sale custom fields exist, so the "asks for comments" toggle can
   * name them rather than describing something abstract.
   *
   * ACTIVE only, because that is what the till would actually ask for. A shop
   * with none gets a hint pointing at the screen where they are defined — a
   * toggle promising to ask questions nobody has written is the one state a
   * manager cannot debug from here.
   */
  const saleFieldCount = (await listFieldDefs(siteId, 'sale').catch(() => [])).filter(
    (f) => f.isActive,
  ).length

  return (
    <>
      <PageHeader
        title="Tender types"
        subtitle="How sales are paid for. Some stores have four, some have ten."
      />
      <PageBody>
        <TenderTypesClient tenders={tenders} saleFieldCount={saleFieldCount} />
      </PageBody>
    </>
  )
}

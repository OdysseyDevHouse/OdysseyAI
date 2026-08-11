import { requireCapability } from '@/lib/auth'
import { listSalesReasons } from '@/lib/site/salesReasons'
import { PageHeader, PageBody } from '@/components/ui'
import SalesReasonsClient from './SalesReasonsClient'

export const dynamic = 'force-dynamic'

export default async function SalesReasonsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  // Retired reasons are shown here and nowhere else: this is the screen that
  // brings one back, so hiding them would make that impossible.
  const [voidReasons, returnReasons] = await Promise.all([
    listSalesReasons(siteId, 'void', true),
    listSalesReasons(siteId, 'return', true),
  ])

  return (
    <>
      <PageHeader
        title="Void & return reasons"
        subtitle="Why a sale was cancelled, and why goods came back. These are what the exception reports group by."
      />
      <PageBody>
        <SalesReasonsClient voidReasons={voidReasons} returnReasons={returnReasons} />
      </PageBody>
    </>
  )
}

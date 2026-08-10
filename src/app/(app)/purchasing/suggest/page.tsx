import { requireCapability } from '@/lib/auth'
import { listSuppliers } from '@/lib/site/suppliers'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import SuggestScreen from './SuggestScreen'

export const dynamic = 'force-dynamic'

export default async function SuggestPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('purchasing.view')

  const [suppliers, locations] = await Promise.all([
    listSuppliers(siteId, { statuses: ['active'], limit: 200 }),
    // Active only: there is no point proposing stock for a room that has been
    // closed, even though one may still hold stock from before.
    listLocations(siteId, false),
  ])

  const main = locations.find((l) => l.isMain) ?? locations[0]

  return (
    <>
      <PageHeader
        title="What to order"
        subtitle="Proposed from your levels and your sales. Nothing is ordered until you say so."
        backHref="/purchasing"
        backLabel="Purchasing"
      />
      <SuggestScreen
        locations={locations.map((l) => ({ id: l.id, code: l.code, name: l.name }))}
        suppliers={suppliers.items.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        defaultLocationId={main?.id ?? 0}
      />
    </>
  )
}

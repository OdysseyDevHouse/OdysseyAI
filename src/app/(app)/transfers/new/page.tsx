import { redirect } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { eligibleStores } from '@/lib/site/storeTransfers'
import { PageHeader } from '@/components/ui'
import NewTransferScreen from './NewTransferScreen'

export const dynamic = 'force-dynamic'

export default async function NewTransferPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('stock.transfer')

  const [locations, stores] = await Promise.all([
    listLocations(siteId, false, true),
    eligibleStores(siteId),
  ])

  /*
   * Nowhere for stock to go: one room and no linked store.
   *
   * The second half of that condition is what changed when store transfers
   * arrived — a shop with a single location and a sibling branch has a
   * perfectly good transfer to make, and redirecting it away was the old
   * behaviour being wrong in a new situation. The list page explains the
   * remaining case properly, so send them there.
   */
  if (locations.length < 2 && stores.length === 0) redirect('/transfers')

  return (
    <>
      <PageHeader
        title="New transfer"
        subtitle={
          stores.length > 0
            ? 'Move stock to another location here, or send it to another store.'
            : 'Move stock from one location to another.'
        }
        backHref="/transfers"
        backLabel="Transfers"
      />
      <NewTransferScreen
        locations={locations.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          isMain: l.isMain,
        }))}
        stores={stores}
      />
    </>
  )
}

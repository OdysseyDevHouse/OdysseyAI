import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getLocation } from '@/lib/site/stockLocations'
import { listShelves } from '@/lib/site/stockBins'
import { PageHeader, PageBody } from '@/components/ui'
import ShelvesClient from './ShelvesClient'

export const dynamic = 'force-dynamic'

/**
 * The shelves and bins inside one stock location.
 *
 * Its own route rather than a modal on the locations list, because this is the
 * screen where a room gets described — a warehouse can run to dozens of shelves,
 * and the order they are dragged into here is the order every count sheet for
 * this location gets printed in.
 */
export default async function ShelvesPage({ params }: { params: Promise<{ id: string }> }) {
  // A hidden menu entry is not a boundary — this URL is typeable. Same module
  // and capability as the locations screen it hangs off.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'setup.edit')
  const locationId = Number((await params).id)
  if (!Number.isFinite(locationId) || locationId <= 0) notFound()

  const location = await getLocation(siteId, locationId)
  if (!location) notFound()

  const shelves = await listShelves(siteId, locationId)

  return (
    <>
      <PageHeader
        title={`Shelves — ${location.name}`}
        subtitle="Where in this room stock is kept. Drag them into the order somebody walks the room; stock take sheets print in that order."
      />
      <PageBody>
        <ShelvesClient locationId={locationId} locationName={location.name} shelves={shelves} />
      </PageBody>
    </>
  )
}

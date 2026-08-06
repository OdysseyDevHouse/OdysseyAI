import { requireCapability } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader, PageBody } from '@/components/ui'
import LocationsClient from './LocationsClient'

export const dynamic = 'force-dynamic'

export default async function LocationsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const locations = await listLocations(siteId, true)

  return (
    <>
      <PageHeader
        title="Stock locations"
        subtitle="The places stock is kept. Sales come from the main one."
      />
      <PageBody>
        <LocationsClient locations={locations} />
      </PageBody>
    </>
  )
}

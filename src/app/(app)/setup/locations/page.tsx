import { requireSiteId } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader, PageBody } from '@/components/ui'
import LocationsClient from './LocationsClient'

export const dynamic = 'force-dynamic'

export default async function LocationsPage() {
  const siteId = await requireSiteId()
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

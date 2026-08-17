import { redirect } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { listManufacturableProducts } from '@/lib/site/manufacturing'
import { PageHeader } from '@/components/ui'
import NewBuildScreen from './NewBuildScreen'

export const dynamic = 'force-dynamic'

export default async function NewBuildPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'products.edit')

  const [locations, buildable] = await Promise.all([
    listLocations(siteId, false, true),
    listManufacturableProducts(siteId),
  ])

  // Nothing is marked as made in batches. The list page explains that properly,
  // so send them there rather than rendering a form with an empty picker.
  if (buildable.length === 0) redirect('/manufacturing')

  return (
    <>
      <PageHeader
        title="New build"
        subtitle="Take the ingredients off the shelf and put the finished item on it."
        backHref="/manufacturing"
        backLabel="Manufacturing"
      />
      <NewBuildScreen
        locations={locations.map((l) => ({ id: l.id, code: l.code, name: l.name, isMain: l.isMain }))}
      />
    </>
  )
}

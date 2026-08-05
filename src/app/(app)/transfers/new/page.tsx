import { redirect } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { PageHeader } from '@/components/ui'
import NewTransferScreen from './NewTransferScreen'

export const dynamic = 'force-dynamic'

export default async function NewTransferPage() {
  const siteId = await requireSiteId()
  const locations = await listLocations(siteId, false)

  // Nothing to transfer between. The list page explains this properly, so send
  // them there rather than rendering a form that cannot be submitted.
  if (locations.length < 2) redirect('/transfers')

  return (
    <>
      <PageHeader
        title="New transfer"
        subtitle="Move stock from one location to another."
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
      />
    </>
  )
}

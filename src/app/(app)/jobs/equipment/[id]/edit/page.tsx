import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getAsset, listAssetTypes } from '@/lib/site/jobAssets'
import { listCustomers } from '@/lib/site/customers'
import { listServiceAddresses } from '@/lib/site/serviceAddresses'
import { PageHeader, PageBody } from '@/components/ui'
import EquipmentForm from '../../EquipmentForm'

export const dynamic = 'force-dynamic'

export default async function EditEquipmentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.edit')
  const { id } = await params

  const assetId = Number(id)
  if (!Number.isFinite(assetId) || assetId <= 0) notFound()

  const asset = await getAsset(siteId, assetId)
  if (!asset) notFound()

  const [types, customers, addresses] = await Promise.all([
    listAssetTypes(siteId, false),
    listCustomers(siteId, { limit: 500 }),
    // Preloaded so the form renders its own site without a round trip. Changing
    // the customer refetches — see EquipmentForm.
    asset.customerId === null
      ? Promise.resolve([])
      : listServiceAddresses(siteId, asset.customerId),
  ])

  return (
    <>
      <PageHeader
        title={`Edit ${asset.description}`}
        subtitle={asset.documentNumber ?? undefined}
      />
      <PageBody>
        <EquipmentForm
          asset={asset}
          types={types.map((t) => ({
            id: t.id,
            name: t.name,
            identifierLabel: t.identifierLabel,
          }))}
          customers={customers.items.map((c) => ({ id: c.id, name: c.name }))}
          initialAddresses={addresses.map((a) => ({ id: a.id, name: a.name }))}
        />
      </PageBody>
    </>
  )
}

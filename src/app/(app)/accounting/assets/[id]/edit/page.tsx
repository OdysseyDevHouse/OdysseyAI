import { notFound, redirect } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getAsset, listCategories } from '@/lib/site/fixedAssets'
import { PageHeader, PageBody } from '@/components/ui'
import { AssetForm } from '../../AssetForm'

export const dynamic = 'force-dynamic'

export default async function EditAssetPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const { id } = await params

  const assetId = Number(id)
  if (!Number.isFinite(assetId)) notFound()

  const asset = await getAsset(siteId, assetId)
  if (!asset) notFound()

  // A disposed asset is a record of what happened, not something to edit.
  if (asset.status === 'disposed') redirect(`/accounting/assets/${assetId}`)

  const categories = await listCategories(siteId)

  return (
    <>
      <PageHeader title={asset.name} subtitle={`${asset.assetCode} · edit`} />
      <PageBody>
        <AssetForm
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            defaultLifeMonths: c.defaultLifeMonths,
            defaultResidualPct: c.defaultResidualPct,
          }))}
          existing={{
            id: asset.id,
            name: asset.name,
            description: asset.description ?? '',
            categoryId: asset.categoryId,
            serialNumber: asset.serialNumber ?? '',
            location: asset.location ?? '',
            status: asset.status,
            acquiredOn: asset.acquiredOn,
            cost: asset.cost,
            residualValue: asset.residualValue,
            lifeMonths: asset.lifeMonths,
            depreciationStart: asset.depreciationStart,
            notes: asset.notes ?? '',
            accumulatedDepreciation: asset.accumulatedDepreciation,
          }}
        />
      </PageBody>
    </>
  )
}

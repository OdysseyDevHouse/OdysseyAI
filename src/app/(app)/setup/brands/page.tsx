import { requireCapability } from '@/lib/auth'
import { listBrandsForSetup } from '@/lib/site/brands'
import { storefrontImagesByIds } from '@/lib/site/storefrontImages'
import { PageHeader, PageBody } from '@/components/ui'
import BrandsClient from './BrandsClient'

export const dynamic = 'force-dynamic'

export default async function BrandsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  /* Inactive brands are shown here and nowhere else: this is the screen that
     brings one back, so hiding them would make that impossible. Every other
     screen calls listBrands(siteId) in lookups.ts and gets the active ones. */
  const brands = await listBrandsForSetup(siteId, true)

  /* The pictures, resolved server-side and in ONE query rather than one per
     brand, so a thumbnail is on screen with the first paint instead of after a
     round trip per row. An id that no longer resolves is simply absent from the
     map — 253 keeps no FK, so a deleted picture leaves a dangling id, and the
     client treats missing and never-set identically. */
  const images = await storefrontImagesByIds(
    siteId,
    brands.map((b) => b.onlineImageId).filter((id): id is number => id !== null),
  )

  return (
    <>
      <PageHeader
        title="Brands"
        subtitle="Who makes what you sell. A brand groups products for filtering, commission rules, stock takes and repricing — renaming one renames it on every product at once."
      />
      <PageBody>
        <BrandsClient
          brands={brands}
          images={brands.flatMap((b) => {
            const image = b.onlineImageId === null ? null : (images.get(b.onlineImageId) ?? null)
            return image ? [[b.id, image] as const] : []
          })}
        />
      </PageBody>
    </>
  )
}

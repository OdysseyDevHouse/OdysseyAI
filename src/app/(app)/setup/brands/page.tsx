import { requireCapability } from '@/lib/auth'
import { listBrandsForSetup } from '@/lib/site/brands'
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

  return (
    <>
      <PageHeader
        title="Brands"
        subtitle="Who makes what you sell. A brand groups products for filtering, commission rules, stock takes and repricing — renaming one renames it on every product at once."
      />
      <PageBody>
        <BrandsClient brands={brands} />
      </PageBody>
    </>
  )
}

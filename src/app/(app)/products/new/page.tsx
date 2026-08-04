import { requireSite } from '@/lib/auth'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { linkedStores } from '@/lib/storeGroups'
import { PageHeader } from '@/components/ui'
import ProductForm from '../ProductForm'

export const dynamic = 'force-dynamic'

export default async function NewProductPage() {
  const site = await requireSite()
  const siteId = site.id

  const [departments, brands, vatRates, structures, costBasis, stores] = await Promise.all([
    listDepartments(siteId),
    listBrands(siteId),
    listVatRates(siteId),
    listPriceStructures(siteId),
    getCostBasis(siteId),
    linkedStores(siteId),
  ])

  const thisStore = stores.find((s) => s.siteId === siteId)

  return (
    <>
      <PageHeader title="New product" subtitle="Normal product" backHref="/products" />
      <div className="p-6">
        <ProductForm
          product={null}
          departments={departments}
          brands={brands}
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
          storeName={site.displayName}
          currentSiteId={siteId}
          // A product that doesn't exist yet is in no other store, so there is
          // nothing to compare against — it starts on the group's defaults.
          linkedStores={[]}
          linkedLines={[]}
          sharesCost={thisStore?.sharesCost ?? true}
          sharesSelling={thisStore?.sharesSelling ?? true}
        />
      </div>
    </>
  )
}

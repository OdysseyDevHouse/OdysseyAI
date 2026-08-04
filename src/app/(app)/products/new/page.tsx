import { requireSiteId } from '@/lib/auth'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { PageHeader } from '@/components/ui'
import ProductForm from '../ProductForm'

export const dynamic = 'force-dynamic'

export default async function NewProductPage() {
  const siteId = await requireSiteId()

  const [departments, brands, vatRates, structures, costBasis] = await Promise.all([
    listDepartments(siteId),
    listBrands(siteId),
    listVatRates(siteId),
    listPriceStructures(siteId),
    getCostBasis(siteId),
  ])

  return (
    <>
      <PageHeader title="New product" subtitle="Normal product" />
      <div className="p-6">
        <ProductForm
          product={null}
          departments={departments}
          brands={brands}
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
        />
      </div>
    </>
  )
}

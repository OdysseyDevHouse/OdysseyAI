import { requireSite } from '@/lib/auth'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { linkedStores } from '@/lib/storeGroups'
import { listGroups as listInstructionGroups } from '@/lib/site/instructions'
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

  // Tolerant of the table not existing yet, so an unmigrated store still gets a
  // working product form rather than a crash.
  const instructionGroups = await listInstructionGroups(siteId).catch(() => [])

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
          // The library is offered straight away; the links are written once
          // the insert has given the product an id.
          instructionGroups={instructionGroups}
          attachedInstructions={[]}
          // Nothing to load: the product has no id yet, so it can have no
          // ingredients, no refer target, no serials and no supplier links.
          // Recipe, refer and supplier rows are captured now and written once
          // the insert has given it one; serials wait for the save, because
          // they are units of stock rather than a description of the product.
          recipeLines={[]}
          referLink={null}
          serials={[]}
          productSuppliers={[]}
        />
      </div>
    </>
  )
}

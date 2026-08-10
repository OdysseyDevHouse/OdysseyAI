import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getProduct } from '@/lib/site/products'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { linkedStores } from '@/lib/storeGroups'
import { shareSettingsFor } from '@/lib/site/shareSettings'
import { readLinkedProducts } from '@/lib/site/productFanout'
import { listGroups as listInstructionGroups, groupsForProduct } from '@/lib/site/instructions'
import { listRecipe, getRefer } from '@/lib/site/productComposition'
import { listSerials } from '@/lib/site/serials'
import { listProductSuppliers } from '@/lib/site/productSuppliers'
import { locationStockFor } from '@/lib/site/stockLocations'
import { Callout, PageBody, PageHeader } from '@/components/ui'
import { listImages } from '@/lib/site/productImages'
import { variantStanding } from '@/lib/site/productVariants'
import ProductForm, { SaveProductButton } from '../ProductForm'
import ProductImages from '../ProductImages'
import VariantsPanel from '../VariantsPanel'
import ProductActions from './ProductActions'

export const dynamic = 'force-dynamic'

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string }>
}) {
  const { id } = await params
  const { saved } = await searchParams
  const productId = Number(id)
  if (!Number.isFinite(productId) || productId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.

  const { capabilities } = await requireCapability('products.edit')

  const site = await requireSite()
  const siteId = site.id

  const [product, departments, brands, vatRates, structures, costBasis, stores, locationStock] =
    await Promise.all([
      getProduct(siteId, productId),
      listDepartments(siteId),
      listBrands(siteId),
      listVatRates(siteId),
      listPriceStructures(siteId),
      getCostBasis(siteId),
      linkedStores(siteId),
      locationStockFor(siteId, productId),
    ])

  if (!product) notFound()

  // Only meaningful once this store is linked to others; a standalone store
  // skips both lookups entirely and the form renders as it always has.
  const thisStore = stores.find((s) => s.siteId === siteId)
  const sharing = stores.length
    ? await shareSettingsFor(
        siteId,
        product.code,
        thisStore?.sharesCost ?? true,
        thisStore?.sharesSelling ?? true,
      )
    : { sharesCost: true, sharesSelling: true }

  const linked = stores.length ? await readLinkedProducts(siteId, product.code) : []

  // The instruction library, plus the ones this product already asks. Both are
  // tolerant of the table not existing yet so an unmigrated store still edits.
  const instructionGroups = await listInstructionGroups(siteId).catch(() => [])
  const attachedInstructions = await groupsForProduct(siteId, product.id)
    .then((gs) => gs.map((g) => g.id))
    .catch(() => [])

  // The setup each product type needs. Only fetched for the type that uses it —
  // a normal product has no ingredient list to read — and each is tolerant of
  // its table not existing yet, so an unmigrated store still edits products.
  const [recipeLines, referLink, serials, productSuppliers, images] = await Promise.all([
    product.productType === 'recipe'
      ? listRecipe(siteId, product.id).catch(() => [])
      : Promise.resolve([]),
    product.productType === 'refer'
      ? getRefer(siteId, product.id).catch(() => null)
      : Promise.resolve(null),
    product.productType === 'serial'
      ? listSerials(siteId, { productId: product.id, limit: 200 })
          .then((r) => r.items)
          .catch(() => [])
      : Promise.resolve([]),
    listProductSuppliers(siteId, product.id).catch(() => []),
    // Tolerant like its neighbours: an unmigrated store still edits products,
    // it simply has no gallery yet.
    listImages(siteId, product.id).catch(() => []),
  ])

  // Same tolerance: a store that has not run 070 yet has no parent_id column,
  // and the product screen must still open.
  const variants = await variantStanding(siteId, product.id).catch(() => ({
    group: null,
    parent: null,
  }))

  // The pricing tables are laid out by THIS store's price structures, but each
  // linked store returns its own tiers by name. Map them across so a tier that
  // exists in both lines up, and one that doesn't simply shows empty.
  const linkedLines = linked
    .filter((view) => view.store.siteId !== siteId)
    /*
     * Only stores that actually carry this product get a pricing row.
     *
     * `available` is the switch on the Stores tab; `found && !archived` covers
     * a store holding the product from before the switch existed. A store that
     * is neither — 6529 "Avo each", which store 2 has never had — showed
     * editable cost and price boxes for goods it does not sell, and anything
     * typed there was written on the next save.
     *
     * Switching a store on re-renders this list from the server, so a newly
     * ticked store gains its row (badged "will be created") before anyone
     * needs to price it.
     */
    .filter((view) => view.available || (view.found && !view.archived))
    .map((view) => {
      const prices: Record<number, number> = {}
      for (const structure of structures) {
        const match = view.prices.find((p) => p.structureName === structure.name)
        prices[structure.id] = match?.sellIncl ?? 0
      }
      return {
        siteId: view.store.siteId,
        name: view.store.displayName,
        siteCode: view.store.siteCode,
        carried: view.found,
        lastCost: view.lastCost,
        // Average cost is that store's own purchase history, which this view
        // does not read; margin there falls back to its last cost.
        averageCost: view.lastCost,
        prices,
      }
    })

  return (
    <>
      <PageHeader
        title="Edit product"
        subtitle={product.description}
        backHref="/products"
        action={
          <>
            {/* Submits the form below by id — it is a sibling of that form, not
                an ancestor, which is exactly what the `form` attribute is for. */}
            <SaveProductButton />
            <ProductActions
              productId={product.id}
              isArchived={product.isArchived}
              name={product.description}
              canDelete={can(capabilities, 'products.delete')}
            />
          </>
        }
      />

      <PageBody>
        {saved === '1' && <Callout tone="success" title="Product saved." />}

        <ProductForm
          product={product}
          departments={departments}
          brands={brands}
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
          storeName={site.displayName}
          currentSiteId={siteId}
          linkedStores={linked}
          locationStock={locationStock}
          linkedLines={linkedLines}
          sharesCost={sharing.sharesCost}
          sharesSelling={sharing.sharesSelling}
          instructionGroups={instructionGroups}
          attachedInstructions={attachedInstructions}
          recipeLines={recipeLines}
          referLink={referLink}
          serials={serials}
          productSuppliers={productSuppliers}
          // Archive and delete live in the header's Actions menu — Save stays
          // the one primary on this screen.
        />

        {/* Above the gallery and below the form, both deliberately. Variants
            change what this product IS — whether it can be sold at all — so it
            outranks merchandising; but it saves on its own, so it sits outside
            the form like the images do. */}
        <VariantsPanel
          productId={product.id}
          productDescription={product.description}
          initialGroup={variants.group}
          isChildOf={variants.parent}
        />

        {/* Below the form rather than inside it: images upload immediately and
            individually, so they are not part of the product's save at all. */}
        <ProductImages productId={product.id} initial={images} />
      </PageBody>
    </>
  )
}

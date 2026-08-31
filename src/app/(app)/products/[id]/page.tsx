import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has as hasModule } from '@/lib/control/modules'
import { getProduct } from '@/lib/site/products'
import { listBrands, listVatRates, listPriceStructures, getCostBasis } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { linkedStores } from '@/lib/storeGroups'
import { ownershipOf } from '@/lib/site/productOwnership'
import { shareSettingsFor } from '@/lib/site/shareSettings'
import { readLinkedProducts } from '@/lib/site/productFanout'
import { listGroups as listInstructionGroups, groupsForProduct } from '@/lib/site/instructions'
import {
  listKitchenPrinters,
  printersForProduct,
  distinctKitchenGroups,
} from '@/lib/site/kitchenPrinters'
import { listRecipe } from '@/lib/site/productComposition'
import { listSerials } from '@/lib/site/serials'
import { listProductSuppliers } from '@/lib/site/productSuppliers'
import { locationStockFor } from '@/lib/site/stockLocations'
import { Callout, PageBody, PageHeader } from '@/components/ui'
import { listImages } from '@/lib/site/productImages'
import { getSetting } from '@/lib/site/settings'
import { variantStanding } from '@/lib/site/productVariants'
import { suggestedMasterCode } from '@/lib/site/masterCodes'
import { referChain, isOnReferLadder } from '@/lib/site/referRange'
import ProductForm, { SaveProductButton } from '../ProductForm'
import ProductImages from '../ProductImages'
import VariantsPanel from '../VariantsPanel'
import BarcodesPanel from '../BarcodesPanel'
import PriceHistoryPanel from '../PriceHistoryPanel'
import { listProductBarcodes } from '@/lib/site/productBarcodes'
import { listPriceHistory } from '@/lib/site/priceHistory'
import { productReportsFor } from '@/lib/reportBuilder/productReports'
import ProductActions from './ProductActions'
import { returnToOr } from '@/lib/returnTo'

export const dynamic = 'force-dynamic'

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string; from?: string }>
}) {
  const { id } = await params
  const { saved, from } = await searchParams

  /* Where leaving this product goes. The list that sent us here when it had
     filters worth keeping, else the plain catalogue.

     Validated rather than trusted: `from` arrives in a typeable URL and ends
     up both in a link and in a redirect, so an absolute one would be an open
     redirect off the back of our own domain. See lib/returnTo.ts. */
  const backHref = returnToOr(from, '/products')
  const productId = Number(id)
  if (!Number.isFinite(productId) || productId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.

  const { capabilities, modules } = await requireCapability('products.edit')

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

  /* Whether this store may change what the product IS.
   *
   * A product belongs to the store whose catalogue it was created in — head
   * office, typically — and every other store may stock, price and sell it but
   * not edit it. See lib/site/productOwnership.ts.
   *
   * Read here so the form can render read-only and SAY WHY. The save action
   * asks again and refuses: this is the courtesy, that is the boundary. */
  const ownership = await ownershipOf(siteId, product.code)

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
  /* Active printers only, but the product's OWN routing regardless: a station
     switched off keeps its links so switching it back on restores the menu. */
  const kitchenPrinters = await listKitchenPrinters(siteId).catch(() => [])
  const attachedKitchenPrinters = await printersForProduct(siteId, product.id).catch(() => [])
  const knownKitchenGroups = await distinctKitchenGroups(siteId).catch(() => [])

  // The setup each product type needs. Only fetched for the type that uses it —
  // a normal product has no ingredient list to read — and each is tolerant of
  // its table not existing yet, so an unmigrated store still edits products.
  const [recipeLines, referChainRows, serials, productSuppliers, extraBarcodes, priceHistory, images, autoCode, pictureFont] = await Promise.all([
    product.productType === 'recipe'
      ? listRecipe(siteId, product.id).catch(() => [])
      : Promise.resolve([]),
    /*
     * The whole ladder, not just this rung's own link: the Refer tab edits the
     * chain and shows every pack size whichever one was opened.
     *
     * Asked by LINK rather than by product type. The base of a ladder is a
     * `normal` product by design, so keying this off `productType === 'refer'`
     * sent it an empty chain and hid the Refer tab from the single at the
     * bottom — the rung most people open first. isOnReferLadder is one indexed
     * lookup that answers false immediately for a product on no ladder.
     */
    isOnReferLadder(siteId, product.id)
      .then((on) => (on ? referChain(siteId, product.id) : []))
      .catch(() => []),
    product.productType === 'serial'
      ? listSerials(siteId, { productId: product.id, limit: 200 })
          .then((r) => r.items)
          .catch(() => [])
      : Promise.resolve([]),
    listProductSuppliers(siteId, product.id).catch(() => []),
    // Tolerant of 143 not having run.
    listProductBarcodes(siteId, product.id).catch(() => []),
    // Tolerant of 144 not having run.
    listPriceHistory(siteId, product.id).catch(() => []),
    // Tolerant like its neighbours: an unmigrated store still edits products,
    // it simply has no gallery yet.
    listImages(siteId, product.id).catch(() => []),
    /*
     * Whether the refer wizard may leave a product code blank. A site without
     * auto-numbering must be told up front rather than at Create.
     *
     * Asked for every product, because the wizard is reachable from the Refer
     * tab and that tab is no longer limited to refer-typed products — the base
     * of a ladder is `normal`. One cached settings read either way.
     */
    suggestedMasterCode(siteId, 'product')
      .then((c) => c !== null)
      .catch(() => false),
    /*
     * The typeface for generated pictures. Read here rather than fetched by the
     * dialog so it is already correct the first time it opens — the picture is
     * drawn the instant the dialog appears, and a font arriving afterwards
     * would repaint under the user.
     */
    getSetting(siteId, 'generate_picture_font').catch(() => ''),
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
        backHref={backHref}
        action={
          <>
            {/* Submits the form below by id — it is a sibling of that form, not
                an ancestor, which is exactly what the `form` attribute is for.

                Hidden entirely when another store owns this product: the
                fields are disabled and the action would refuse, so a Save
                button here could only ever produce an error. The banner on
                the form says who to ask instead. */}
            {ownership.canEdit && <SaveProductButton />}
            <ProductActions
              productId={product.id}
              returnTo={backHref === '/products' ? null : backHref}
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
          /* Only when it differs from the default — a bare '/products' is what
             the action falls back to anyway, so carrying it is noise. */
          returnTo={backHref === '/products' ? null : backHref}
          product={product}
          departments={departments}
          brands={brands}
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
          storeName={site.displayName}
          currentSiteId={siteId}
          linkedStores={linked}
          ownership={ownership}
          locationStock={locationStock}
          linkedLines={linkedLines}
          sharesCost={sharing.sharesCost}
          sharesSelling={sharing.sharesSelling}
          instructionGroups={instructionGroups}
          attachedInstructions={attachedInstructions}
          kitchenPrinters={kitchenPrinters}
          attachedKitchenPrinters={attachedKitchenPrinters}
          knownKitchenGroups={knownKitchenGroups}
          recipeLines={recipeLines}
          referChain={referChainRows}
          autoCode={autoCode}
          pictureFont={pictureFont}
          serials={serials}
          productSuppliers={productSuppliers}
          /* Module first, then capability — the same order and the same two
             gates the Adjustments screen applies. The action re-checks both. */
          canQuickAdjust={
            hasModule(modules, 'inventory_advanced') && can(capabilities, 'stock.adjust')
          }
          // Archive and delete live in the header's Actions menu — Save stays
          // the one primary on this screen.
          //
          // Handed to the form rather than rendered after it: both belong to
          // the General tab, and as siblings they showed under Properties,
          // Recipe and every other tab as well. The form places them inside
          // General but still outside <form>, which each of them needs.
          generalExtras={
            <>
              {/* Above the gallery, deliberately. Variants change what this
                  product IS — whether it can be sold at all — so it outranks
                  merchandising. */}
              <VariantsPanel
                productId={product.id}
                productDescription={product.description}
                initialGroup={variants.group}
                isChildOf={variants.parent}
              />

              {/* Images upload immediately and individually, so they are not
                  part of the product's save at all. */}
              <ProductImages productId={product.id} initial={images} />

              {/* The alias barcodes (143). Self-saving, like its siblings. */}
              <BarcodesPanel productId={product.id} initial={extraBarcodes} />

              {/* Price history has MOVED to the Reporting tab — it is history,
                  which is what that tab is for, and the General tab was long. */}
            </>
          }
          /* Filtered here rather than in the panel: a capability check belongs
             on the server, and the tab is hidden entirely when none survive. */
          reports={productReportsFor((c) => can(capabilities, c)).map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
          }))}
          /* Keyed because this element is created on the SERVER and handed to a
             client component as a prop: it crosses the RSC boundary, is spliced
             into that component's children as an array element, and React then
             key-validates it like any other list child. */
          priceHistory={<PriceHistoryPanel key="price-history" rows={priceHistory} />}
        />
      </PageBody>
    </>
  )
}

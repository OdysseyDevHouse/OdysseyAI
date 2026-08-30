'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  requireSiteId,
  requireCapability,
  actorFor,
  actorForOrThrow,
  actorForModuleOrThrow,
} from '@/lib/auth'
import { toProductType } from '@/lib/productTypes'
import { safeReturnTo } from '@/lib/returnTo'
import { toVariableType, toPriceCalc } from '@/lib/productProperties'
import { linkedStores } from '@/lib/storeGroups'
import { setShareSettings } from '@/lib/site/shareSettings'
import { fanoutProduct } from '@/lib/site/productFanout'
import { setGroupsForProduct } from '@/lib/site/instructions'
import { setPrintersForProduct } from '@/lib/site/kitchenPrinters'
import { saveLocationLevels } from '@/lib/site/stockLocations'
import { listPriceStructures, listVatRates } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { listReasons, postNewAdjustment } from '@/lib/site/stockAdjustments'
import { can, type Capability } from '@/lib/site/permissions'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { type ReportColumn } from '@/lib/reportBuilder/spec'
import { PRODUCT_REPORTS } from '@/lib/reportBuilder/productReports'
import {
  createProduct,
  updateProduct,
  setArchived,
  setDerivedCost,
  deleteProduct,
  getProduct,
  propertyColumnMap,
  bulkUpdateProducts,
  quickUpdateProduct,
  type ProductInput,
  type ProductQuickEdit,
  type ProductBulkChange,
  type ProductBulkResult,
} from '@/lib/site/products'
import {
  saveRecipe,
  compositionCost,
  type RecipeInput,
} from '@/lib/site/productComposition'
import {
  saveProductSuppliers,
  type ProductSupplierInput,
} from '@/lib/site/productSuppliers'

export type ProductFormState = { error: string | null }

function num(form: FormData, key: string): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return 0
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * A Properties-tab switch, submitted as "1"/"0" via a hidden input.
 *
 * `whenAbsent` covers the field being missing entirely — an older form post, or
 * a screen that does not render the tab. It must match the column default so a
 * save from such a form does not silently flip the setting.
 */
function flag(form: FormData, key: string, whenAbsent = false): boolean {
  const raw = form.get(key)
  if (raw === null) return whenAbsent
  return String(raw) === '1'
}

/**
 * A number the form may legitimately not submit at all.
 *
 * Distinct from num(): that reads an absent field as 0, which is right for a
 * cost box the user cleared but wrong for the reorder levels, which moved to
 * product_location_stock and are no longer on this form. Undefined tells the
 * update to COALESCE and keep whatever the column already held, rather than
 * wiping it on every save.
 */
function optionalNum(form: FormData, key: string): number | undefined {
  const raw = form.get(key)
  if (raw === null) return undefined
  const trimmed = String(raw).trim()
  if (!trimmed) return undefined
  const n = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

function optionalId(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

const toNumber = (value: FormDataEntryValue) => {
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Shared selling prices arrive as price_<structureId> fields. */
function readPrices(form: FormData): Record<number, number> {
  const prices: Record<number, number> = {}
  for (const [key, value] of form.entries()) {
    const match = /^price_(\d+)$/.exec(key)
    if (match) prices[Number(match[1])] = toNumber(value)
  }
  return prices
}

/**
 * The sharing toggles submit "1"/"0" through hidden inputs rather than relying
 * on checkbox presence — an unchecked checkbox sends nothing, which is
 * indistinguishable from "field absent" and would read as unchanged.
 */
function readShareFlag(form: FormData, key: string): boolean | undefined {
  const raw = form.get(key)
  if (raw === null) return undefined
  return String(raw) === '1'
}

/**
 * Figures typed against another store, keyed by that store's site id.
 *
 * Fields are storeCost_<siteId> and storePrice_<siteId>_<structureId>. A shared
 * figure renders read-only and submits nothing, so anything found here is by
 * definition a value the user meant that store to keep on its own.
 */
type PerStoreValues = {
  lastCost?: number
  prices?: Record<number, number>
  minStock?: number
  maxStock?: number
}

/**
 * Reorder levels typed into the per-LOCATION table.
 *
 * Fields are locMinStock_<locationId> and locMaxStock_<locationId>. The `loc`
 * prefix is not decoration: minStock_<n> already means "the linked STORE with
 * site id n", and a location id would collide with a site id in that pattern —
 * routing a warehouse level into another store's fan-out.
 */
type LocationLevels = { minStock?: number; maxStock?: number }

function readLocationLevels(form: FormData): Record<number, LocationLevels> {
  const out: Record<number, LocationLevels> = {}
  const ensure = (locationId: number) => (out[locationId] ??= {})

  for (const [key, value] of form.entries()) {
    const min = /^locMinStock_(\d+)$/.exec(key)
    if (min) {
      ensure(Number(min[1])).minStock = toNumber(value)
      continue
    }
    const max = /^locMaxStock_(\d+)$/.exec(key)
    if (max) {
      ensure(Number(max[1])).maxStock = toNumber(value)
    }
  }
  return out
}

function readPerStore(form: FormData): Record<number, PerStoreValues> {
  const out: Record<number, PerStoreValues> = {}
  const ensure = (siteId: number) => (out[siteId] ??= {})

  for (const [key, value] of form.entries()) {
    const cost = /^storeCost_(\d+)$/.exec(key)
    if (cost) {
      ensure(Number(cost[1])).lastCost = toNumber(value)
      continue
    }
    const min = /^minStock_(\d+)$/.exec(key)
    if (min) {
      ensure(Number(min[1])).minStock = toNumber(value)
      continue
    }
    const max = /^maxStock_(\d+)$/.exec(key)
    if (max) {
      ensure(Number(max[1])).maxStock = toNumber(value)
      continue
    }
    const price = /^storePrice_(\d+)_(\d+)$/.exec(key)
    if (price) {
      const entry = ensure(Number(price[1]))
      entry.prices ??= {}
      entry.prices[Number(price[2])] = toNumber(value)
    }
  }
  return out
}

/**
 * Which stores should carry this product, from available_<siteId> fields.
 *
 * Hidden inputs carry "1"/"0" for the same reason the sharing flags do: an
 * unchecked switch submits nothing, and "absent" would read as unchanged rather
 * than as "remove it from that store".
 */
function readAvailability(form: FormData): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  for (const [key, value] of form.entries()) {
    const match = /^available_(\d+)$/.exec(key)
    if (match) out[Number(match[1])] = String(value) === '1'
  }
  return out
}

/**
 * The recipe rows, zipped back from three parallel arrays.
 *
 * Parallel rather than indexed names (recipeQty_0, recipeQty_1, …) because rows
 * are deleted from the middle of the list. Indexed names would leave gaps that
 * every reader has to guess the length of; getAll() keeps the three lists in
 * lockstep by construction, and the shortest one bounds the result.
 */
function readRecipe(form: FormData): RecipeInput[] {
  const ids = form.getAll('recipeComponent')
  const qtys = form.getAll('recipeQty')
  const wastages = form.getAll('recipeWastage')

  const lines: RecipeInput[] = []
  for (let i = 0; i < ids.length; i++) {
    const componentId = Number(ids[i])
    if (!Number.isFinite(componentId) || componentId <= 0) continue
    lines.push({
      componentId,
      qty: toNumber(qtys[i] ?? '0'),
      wastagePct: toNumber(wastages[i] ?? '0'),
    })
  }
  return lines
}

/** The supplier links, zipped the same way and for the same reason. */
function readProductSuppliers(form: FormData): ProductSupplierInput[] {
  const ids = form.getAll('supplierId')
  const codes = form.getAll('supplierCode')
  const costs = form.getAll('supplierCost')
  const packs = form.getAll('supplierPackSize')

  const preferredRaw = String(form.get('supplierPreferred') ?? '').trim()
  const preferred = preferredRaw ? Number(preferredRaw) : null

  const links: ProductSupplierInput[] = []
  for (let i = 0; i < ids.length; i++) {
    const supplierId = Number(ids[i])
    if (!Number.isFinite(supplierId) || supplierId <= 0) continue
    links.push({
      supplierId,
      supplierCode: String(codes[i] ?? '').trim() || null,
      lastCost: toNumber(costs[i] ?? '0'),
      packSize: toNumber(packs[i] ?? '1'),
      isPreferred: supplierId === preferred,
    })
  }
  return links
}

function readInput(form: FormData): ProductInput {
  return {
    code: String(form.get('code') ?? ''),
    barcode: String(form.get('barcode') ?? '') || null,
    description: String(form.get('description') ?? ''),
    // Sanitised server-side in lib/site/products.ts — never trusted from here.
    extraDescription: String(form.get('extraDescription') ?? '') || null,
    /* `undefined` when the field was never rendered, so the update COALESCEs
       and keeps the column — the same distinction optionalNum() draws above.
       An empty STRING is a real answer meaning "no heading"; a missing field is
       not an answer at all, and reading the two as one would wipe a
       restaurant's courses on any save posted from a form without the tab. */
    kitchenGroup: form.get('kitchenGroup') === null ? undefined : String(form.get('kitchenGroup')),
    // Narrowed rather than trusted: an unknown value falls back to 'normal'.
    productType: toProductType(form.get('productType')),
    // Only read for a recipe; products.ts stores 0 for every other type.
    isManufactured: flag(form, 'isManufactured'),
    departmentId: optionalId(form, 'departmentId'),
    brandId: optionalId(form, 'brandId'),
    imageColor: String(form.get('imageColor') ?? '') || null,
    purchaseVatRateId: optionalId(form, 'purchaseVatRateId'),
    sellingVatRateId: optionalId(form, 'sellingVatRateId'),
    lastCost: num(form, 'lastCost'),
    openingStock: num(form, 'openingStock'),
    // Reorder levels are NOT here: they belong to a (product, location) pair
    // and are written by saveLocationLevels below.
    isArchived: form.get('isArchived') === 'on',

    // Properties tab. The switches submit "1"/"0" through hidden inputs for the
    // same reason the sharing flags do — an off switch sends nothing at all.
    visibleInPos: flag(form, 'visibleInPos', true),
    changeDescription: flag(form, 'changeDescription'),
    askPriceAtSale: flag(form, 'askPriceAtSale'),
    allowFractions: flag(form, 'allowFractions'),
    chargePctSubtotal: flag(form, 'chargePctSubtotal'),
    nonGpProduct: flag(form, 'nonGpProduct'),
    maxDiscountPct: num(form, 'maxDiscountPct'),
    variableType: toVariableType(form.get('variableType')),
    priceCalc: toPriceCalc(form.get('priceCalc')),

    packWeight: num(form, 'packWeight'),
    weightDescription: String(form.get('weightDescription') ?? '') || 'Kg',
    packSize: num(form, 'packSize'),
    packDescription: String(form.get('packDescription') ?? '') || 'None',
    lengthMm: num(form, 'lengthMm'),
    widthMm: num(form, 'widthMm'),
    heightMm: num(form, 'heightMm'),
    prepTimeMinutes: num(form, 'prepTimeMinutes'),

    scaleItem: flag(form, 'scaleItem'),
    labelScaleItem: flag(form, 'labelScaleItem'),
    fixedPriceScale: flag(form, 'fixedPriceScale'),
    expiresInDays: num(form, 'expiresInDays'),

    prices: readPrices(form),
    sharesCost: readShareFlag(form, 'sharesCost'),
    sharesSelling: readShareFlag(form, 'sharesSelling'),
  }
}

export async function saveProductAction(
  _prev: ProductFormState,
  form: FormData,
): Promise<ProductFormState> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  /*
   * A product belongs to the store whose catalogue it was created in, and only
   * that store may change what it IS — see lib/site/productOwnership.ts.
   *
   * Checked HERE, not only by greying the fields: the screen is a courtesy and
   * the action is the boundary. Only an EDIT is guarded; creating a product is
   * always this store's own, which is exactly how a branch adds its local
   * lines alongside head office's range.
   */
  if (idRaw) {
    const existing = await getProduct(siteId, Number(idRaw))
    if (existing) {
      const { editRefusal } = await import('@/lib/site/productOwnership')
      const refusal = await editRefusal(siteId, existing.code)
      if (refusal) return { error: refusal }
    }
  }

  // Named on the price history (144): who moved the shelf, through the editor.
  const audit = { source: 'editor' as const, userName: ctx.actor.userName }
  const result = idRaw
    ? await updateProduct(siteId, Number(idRaw), input, audit)
    : await createProduct(siteId, input, audit)

  if (!result.ok) return { error: result.error }

  // Reorder levels per stock location. Only levels — stock_on_hand is a
  // consequence of movements and this form never writes it.
  //
  // Not allowed to fail the save that already succeeded, for the same reason
  // the instruction groups below are not: the product is already written, and
  // throwing here would show an error for a save that did happen.
  for (const [locationId, levels] of Object.entries(readLocationLevels(form))) {
    await saveLocationLevels(siteId, result.id, Number(locationId), {
      minStock: levels.minStock ?? 0,
      maxStock: levels.maxStock ?? 0,
    }).catch(() => {})
  }

  // Which instructions this product asks. Only ticked ids are submitted, so the
  // list is the complete intended set and anything absent was unticked.
  // Never allowed to fail the save that already succeeded.
  await setGroupsForProduct(
    siteId,
    result.id,
    form
      .getAll('instructionGroup')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0),
  ).catch(() => {})

  /*
   * Which kitchen printers this product goes to. Same shape as the instruction
   * groups above and the same rule: the submitted ids are the complete intended
   * set, so an unticked station really unroutes.
   *
   * Guarded on the field having been RENDERED, unlike the instructions. An empty
   * list is a meaningful save ("this stops going to the kitchen"), so it cannot
   * be told apart from a post that never had the tab — and wiping a
   * restaurant's routing because a bulk edit posted a partial form is exactly
   * the silent data loss the suppliers block below guards against. The panel
   * submits `kitchenGroup` unconditionally, so its presence is what says the
   * tab was there.
   */
  if (form.get('kitchenGroup') !== null) {
    await setPrintersForProduct(
      siteId,
      result.id,
      form
        .getAll('kitchenPrinter')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0),
    ).catch(() => {})
  }

  // Who this product is bought from. Replaces the whole set, so a supplier the
  // user removed on screen really goes.
  //
  // Only when the tab actually rendered: `supplierPreferred` is submitted
  // unconditionally by the panel, so its absence means the form never had the
  // tab — and wiping every supplier link on such a post would be silent
  // data loss.
  if (form.get('supplierPreferred') !== null) {
    const suppliers = await saveProductSuppliers(siteId, result.id, readProductSuppliers(form))
    if (!suppliers.ok) return { error: suppliers.error }
  }

  // Composition. Reported rather than swallowed: a recipe that failed to save
  // leaves a product that deducts the wrong stock at the till, which is far
  // worse than a save that says why it stopped.
  const productType = input.productType ?? 'normal'

  if (productType === 'recipe') {
    const recipe = await saveRecipe(siteId, result.id, readRecipe(form))
    if (!recipe.ok) return { error: recipe.error }

    /*
     * The stored cost of a recipe is DERIVED, never accepted from the post.
     *
     * The form shows it read-only and submits it, but a server action is a
     * public endpoint and a read-only input is not a boundary — the posted
     * figure could say anything. Recomputing from the lines that were just
     * saved also fixes the honest case: an ingredient repriced since this page
     * loaded, so the browser's total was stale before it was sent.
     *
     * compositionCost() is the same function the till charges a sale at, so the
     * catalogue and the GP report cannot disagree about what a burger cost.
     * Null means the lines could not be resolved — leave the existing figure
     * rather than writing a zero over it.
     */
    const cost = await compositionCost(siteId, result.id, 'recipe').catch(() => null)
    if (cost !== null) await setDerivedCost(siteId, result.id, cost)
  }

  /*
   * Refer links are NOT saved here any more.
   *
   * The Refer tab edits a whole chain and adding a pack size creates a
   * product, so it saves itself through referRangeActions the way Variants and
   * Serials do — see ReferPanel.tsx. This form never carries referTarget, and
   * a branch here reading a field nothing submits would look live while doing
   * nothing, which is worse than its absence.
   *
   * The COST is the exception, and it moves the other way — down the form and
   * up every chain built on this product. A case of 24 costs 24 singles, so
   * repricing the single has to reprice every pack drawing on it; nothing on
   * the Refer tab offers a cost box precisely because the factor already
   * decides the answer. Without this the packs kept whatever they were seeded
   * with — usually 0.00 — and reported a 100% margin on every sale.
   *
   * RECIPES CLIMB THE SAME WALK. Type a new cost on tomatoes and every burger
   * listing tomatoes is recosted, including burgers reached through another
   * made item. A recipe's stored cost is a cache of compositionCost(), and a
   * cache nothing invalidates is a wrong number that looks authoritative —
   * before this it moved only when the burger itself was next saved, so the
   * till charged one cost and every report showed another.
   *
   * Runs for EVERY product, not just one typed 'refer' or 'recipe': the thing
   * being repriced is the INGREDIENT or the base of a ladder, which is
   * deliberately an ordinary product (see createReferRange). A type check here
   * would skip the one rung people actually reprice. A product with nothing
   * above it costs one cheap query and writes nothing.
   */
  const { cascadeReferCosts } = await import('@/lib/site/referRange')
  await cascadeReferCosts(siteId, result.id).catch(() => 0)

  // This store's own database is now saved. Everything below concerns the OTHER
  // linked stores, and must never turn a successful save into a failed one — a
  // store that cannot be reached is reported, not thrown.
  const code = input.code.trim()
  const stores = await linkedStores(siteId).catch(() => [])

  if (stores.length > 1) {
    const thisStore = stores.find((s) => s.siteId === siteId)
    const groupCost = thisStore?.sharesCost ?? true
    const groupSelling = thisStore?.sharesSelling ?? true

    if (input.sharesCost !== undefined && input.sharesSelling !== undefined) {
      await setShareSettings(
        siteId,
        code,
        { sharesCost: input.sharesCost, sharesSelling: input.sharesSelling },
        groupCost,
        groupSelling,
      ).catch(() => {})
    }

    // Only fan out what this product actually shares. An unshared figure stays
    // in this store, but descriptive fields always travel — they are what makes
    // it the same product in every store.
    const structures = await listPriceStructures(siteId).catch(() => [])

    // The form submits VAT ids, which are per-database. Resolve them to
    // percentages here so the fan-out can find each target store's own row at
    // the same rate.
    const rates = await listVatRates(siteId).catch(() => [])
    const rateOf = (id: number | null | undefined) =>
      id == null ? undefined : rates.find((r) => r.id === id)?.rate

    // The store you are signed into cannot un-stock itself. The screen disables
    // that switch, but the guard belongs here too: a form post is not a trusted
    // input, and archiving the product you are editing out from under yourself
    // is not something any request should be able to ask for.
    const availability = readAvailability(form)
    delete availability[siteId]

    await fanoutProduct(
      siteId,
      code,
      {
        lastCost: input.lastCost ?? 0,
        prices: input.prices ?? {},
        description: input.description.trim(),
        barcode: input.barcode?.trim() || null,
        extraDescription: input.extraDescription ?? null,
        productType: input.productType ?? 'normal',
        properties: propertyColumnMap(input),
        perStore: readPerStore(form),
        purchaseVatPercent: rateOf(input.purchaseVatRateId),
        sellingVatPercent: rateOf(input.sellingVatRateId),
        // By NAME, resolved here against THIS store. Department ids are
        // per-database — on the dev data, 9 is "Cooldrinks" in one store and
        // does not exist in the other, whose 11-16 are different departments
        // entirely — so sending the id would file the product under whatever
        // happened to share that number.
        departmentName: input.departmentId
          ? ((await listDepartments(siteId).catch(() => []))
              .find((d) => d.id === input.departmentId)?.name ?? null)
          : null,
      },
      structures.map((s) => ({ id: s.id, name: s.name })),
      availability,
    ).catch(() => [])
  }

  revalidatePath('/products')

  /* Saving keeps you ON the product — it is not necessarily the end of the
     edit, and bouncing to the list after every field change would make a
     two-part correction into two round trips.

     What it must NOT do is lose the list that sent you here: the redirect
     rebuilds the URL from scratch, so without carrying `from` the Back arrow
     silently reverted to the bare catalogue on the first save. That is what
     made a filtered worklist unusable. */
  const back = safeReturnTo(form.get('returnTo'))
  const from = back ? `&from=${encodeURIComponent(back)}` : ''
  redirect(`/products/${result.id}?saved=1${from}`)
}

export async function archiveProductAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('products.edit')
  const { siteId } = ctx
  const id = Number(form.get('id'))
  const archived = String(form.get('archived')) === '1'

  if (Number.isFinite(id) && id > 0) await setArchived(siteId, id, archived)

  revalidatePath('/products')
  // Same as the save path: keep the list that sent us here. See above.
  const back = safeReturnTo(form.get('returnTo'))
  redirect(`/products/${id}${back ? `?from=${encodeURIComponent(back)}` : ''}`)
}

export async function deleteProductAction(form: FormData): Promise<void> {
  // Deleting is its own capability, not a stronger flavour of editing: somebody
  // who fixes descriptions all day should not be able to remove the record.
  const ctx = await actorForOrThrow('products.delete')
  const { siteId } = ctx
  const id = Number(form.get('id'))
  if (!Number.isFinite(id) || id <= 0) redirect('/products')

  const result = await deleteProduct(siteId, id)
  revalidatePath('/products')

  /* The list this was opened from, kept across all three outcomes below. Two
     of them stay on the product and need it for the Back arrow; the third
     returns to the list itself, which is the one place the filtered worklist
     genuinely has to survive — deleting one of ten is exactly the moment you
     want the other nine still on screen. */
  const back = safeReturnTo(form.get('returnTo'))
  const from = back ? `&from=${encodeURIComponent(back)}` : ''

  if (!result.ok) {
    redirect(`/products/${id}?error=${encodeURIComponent(result.error)}${from}`)
  }

  // A product with sales history is archived rather than deleted. Say so:
  // silently doing something other than what was asked is worse than refusing.
  if (result.archived) {
    redirect(`/products/${id}?archived=1&reason=${encodeURIComponent(result.reason)}${from}`)
  }

  redirect(back ? `${back}${back.includes('?') ? '&' : '?'}deleted=1` : '/products?deleted=1')
}

/**
 * Applies one bulk change to the selected products.
 *
 * Returns the result rather than redirecting, exactly as the customer and
 * supplier bulk actions do, so the list can toast "38 updated, 2 skipped —
 * ABC-1, ABC-2" instead of bouncing the user to a page that says nothing.
 */
export async function bulkUpdateProductsAction(
  ids: number[],
  change: ProductBulkChange,
): Promise<ProductBulkResult> {
  // Deleting is its own capability, not a stronger flavour of editing — the
  // same split deleteProductAction makes, for the same reason.
  const ctx = await actorForOrThrow(change.kind === 'delete' ? 'products.delete' : 'products.edit')
  const { siteId } = ctx

  const result = await bulkUpdateProducts(siteId, ids, change)
  revalidatePath('/products')
  return result
}

/* ── Quick adjust ────────────────────────────────────────────────────────── */

/**
 * The reasons a quick adjustment may name, for the modal's picker.
 *
 * Gated the same way the adjustments screen is — module first, then capability.
 * Someone who cannot open /adjustments/new must not be able to reach the same
 * posting path through a product.
 */
export async function adjustmentReasonsAction(): Promise<
  { id: number; name: string; direction: 'in' | 'out' | 'both' }[]
> {
  const { siteId } = await actorForModuleOrThrow('inventory_advanced', 'stock.adjust')
  const reasons = await listReasons(siteId, false)
  return reasons.map((r) => ({ id: r.id, name: r.name, direction: r.direction }))
}

/**
 * Adjusts ONE product at ONE location, from the product screen.
 *
 * Delegates to `postNewAdjustment` rather than writing a movement: that
 * function creates the draft, posts it, mirrors to the GL and keeps the draft
 * if posting is refused. Writing stock directly here would skip the document
 * trail, the GL and the reversal path — and nothing would notice until a
 * reconcile check failed, long after anyone could say why.
 *
 * So this is a thin wrapper whose whole job is to refuse what a single-line
 * modal cannot express, and then hand over.
 */
export async function quickAdjustAction(input: {
  productId: number
  locationId: number
  qtyChange: number
  reasonId: number
  note?: string
}): Promise<{ ok: true; documentNumber: string } | { ok: false; error: string }> {
  const { siteId, actor } = await actorForModuleOrThrow('inventory_advanced', 'stock.adjust')

  const product = await getProduct(siteId, input.productId)
  if (!product) return { ok: false, error: 'That product no longer exists.' }

  /*
   * Serial products are refused rather than adjusted.
   *
   * A serial line carries the UNITS going off the shelf, and writeOffSerialsTx
   * returns ok on an empty list — so a quantity-only adjustment would post
   * happily, move products.stock_on_hand, and leave every serial row untouched.
   * That breaks invariant (S1), count(in_stock serials) = stock_on_hand, with
   * nothing on the document to explain it. Ticking units needs the full screen.
   */
  if (product.productType === 'serial') {
    return {
      ok: false,
      error:
        'This product tracks individual units, so an adjustment has to say which ones. Use Stock → Adjustments.',
    }
  }

  const result = await postNewAdjustment(siteId, actor, {
    locationId: input.locationId,
    reasonId: input.reasonId,
    note: input.note?.trim() || null,
    lines: [
      {
        productId: product.id,
        productCode: product.code,
        description: product.description,
        qtyChange: input.qtyChange,
      },
    ],
  })

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/products/${input.productId}`)
  return { ok: true, documentNumber: result.documentNumber }
}

/* ── Product reports ─────────────────────────────────────────────────────── */

export type ProductReportResult =
  | {
      ok: true
      columns: ReportColumn[]
      rows: Record<string, unknown>[]
      totals: Record<string, number>
      range: { from: string; to: string }
      truncated: boolean
    }
  | { ok: false; error: string }

/**
 * Runs one of the product Reporting-tab reports.
 *
 * The browser sends a report ID, never a spec. The builder's own preview action
 * takes a whole spec back from the client and has to re-validate it against the
 * catalog for exactly that reason; here the spec is composed server-side from
 * an id and this product, so a tampered request can only ever name a report
 * that exists or none at all.
 *
 * The capability is still checked twice: once to decide whether the report is
 * offered, and again inside runBuilderSpec against the source's own permission.
 * A product report reads sales, stock or purchasing data, and being allowed to
 * edit a product is not being allowed to see any of that.
 */
export async function runProductReportAction(
  productId: number,
  reportId: string,
): Promise<ProductReportResult> {
  const { siteId, capabilities } = await requireCapability('products.view')
  const allow = (c: Capability) => can(capabilities, c)

  const report = PRODUCT_REPORTS.find((r) => r.id === reportId)
  if (!report) return { ok: false, error: 'That report does not exist.' }
  if (!allow(report.permission)) {
    return { ok: false, error: 'You do not have access to this data.' }
  }

  const product = await getProduct(siteId, productId)
  if (!product) return { ok: false, error: 'That product no longer exists.' }

  try {
    const result = await runBuilderSpec(
      siteId,
      report.spec({ id: product.id, code: product.code }),
      allow,
    )
    return {
      ok: true,
      columns: result.columns,
      rows: result.rows,
      totals: result.totals,
      range: result.range,
      truncated: result.truncated,
    }
  } catch (e) {
    if (e instanceof ReportAccessError) {
      return { ok: false, error: 'You do not have access to this data.' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'This report could not be run.',
    }
  }
}

/* ── Quick edit ──────────────────────────────────────────────────────────── */

/**
 * The products list's slide-in panel: a few fields, changed without opening the
 * product.
 *
 * Deliberately NOT `saveProductAction` with a smaller form. That action reads a
 * whole ProductInput out of the FormData and hands it to `updateProduct`, which
 * writes a whole product — so a six-field form posted through it would clear
 * the prices, recipe lines and supplier links it never rendered. This one names
 * the fields it changes and leaves everything else alone.
 */
export async function quickEditProductAction(
  id: number,
  /*
   * The code is NOT accepted here, though quickUpdateProduct can write one.
   *
   * A product code is its identity — printed on labels, quoted on orders, sat
   * in documents already issued — so changing one belongs on the full product
   * where that weight is obvious, not in a panel opened to fix a price. The
   * panel renders it read-only; this makes the endpoint agree, because a
   * server action is a public entry point and a greyed box is not a boundary.
   */
  patch: Omit<ProductQuickEdit, 'code'>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error ?? 'You may not edit products.' }
  const { siteId } = ctx

  const existing = await getProduct(siteId, id)
  if (!existing) return { ok: false, error: 'That product no longer exists.' }

  /* The same ownership rule the full editor enforces: a product belongs to the
     store whose catalogue created it, and only that store may change what it
     IS. The panel is a courtesy; this is the boundary. */
  const { editRefusal } = await import('@/lib/site/productOwnership')
  const refusal = await editRefusal(siteId, existing.code)
  if (refusal) return { ok: false, error: refusal }

  const result = await quickUpdateProduct(siteId, id, patch, {
    userName: ctx.actor.userName,
  })
  if (!result.ok) return { ok: false, error: result.error }

  /*
   * Everything built out of this product, when its COST moved.
   *
   * The same cascade saveProductAction runs, for the same reason and with the
   * same "never fails the save" contract. It was missing here, and the gap was
   * invisible in exactly the way that matters: this panel is the quickest way
   * to reprice an ingredient, so it is the path somebody actually uses to put
   * mince up from 118 to 180 — and every burger containing that mince kept the
   * cost it had, while the recipe screen went on showing 118.
   *
   * Guarded on the patch naming a cost: a description or barcode edit changes
   * nothing any recipe reads, and walking the tree for one would be work with
   * no possible result.
   */
  if (patch.lastCost !== undefined) {
    const { cascadeCompositionCosts } = await import('@/lib/site/productComposition')
    await cascadeCompositionCosts(siteId, id).catch(() => 0)
  }

  /*
   * ── KEEPING A LINKED GROUP IN STEP ───────────────────────────────────────
   *
   * Descriptive fields always travel to the other stores in a group — they are
   * what makes it the same product everywhere — and cost and price travel when
   * the group shares them. A quick edit that skipped this would leave one store
   * showing the new description and every sibling showing the old one, with
   * nothing on screen to say why.
   *
   * Fanned out from the product as it now STANDS, re-read after the write,
   * rather than from the patch: the patch is a handful of fields, and
   * FanoutValues wants the whole picture. Reading it back sends the saved
   * truth instead of a reconstruction of it.
   *
   * Everything here concerns OTHER databases and must never turn a successful
   * save into a failed one — the same rule saveProductAction follows.
   */
  const saved = await getProduct(siteId, id).catch(() => null)
  const stores = await linkedStores(siteId).catch(() => [])
  if (saved && stores.length > 1) {
    const rates = await listVatRates(siteId).catch(() => [])
    const rateOf = (rateId: number | null | undefined) =>
      rateId == null ? undefined : rates.find((r) => r.id === rateId)?.rate
    const structures = await listPriceStructures(siteId).catch(() => [])

    await fanoutProduct(
      siteId,
      saved.code,
      {
        lastCost: saved.lastCost ?? 0,
        prices: Object.fromEntries(saved.prices.map((p) => [p.priceStructureId, p.sellIncl])),
        description: saved.description,
        barcode: saved.barcode,
        extraDescription: saved.extraDescription ?? null,
        productType: saved.productType ?? 'normal',
        purchaseVatPercent: rateOf(saved.purchaseVatRateId),
        sellingVatPercent: rateOf(saved.sellingVatRateId),
        /* By NAME, not id: department ids are per-database, so sending the id
           would file the product under whatever happened to share that number
           in the target store. */
        departmentName: saved.departmentId
          ? ((await listDepartments(siteId).catch(() => [])).find(
              (d) => d.id === saved.departmentId,
            )?.name ?? null)
          : null,
      },
      structures.map((s) => ({ id: s.id, name: s.name })),
      /* No availability map: this panel shows no store toggles, and an empty
         map means every store keeps what it had. */
    ).catch(() => [])
  }

  revalidatePath('/products')
  return { ok: true }
}

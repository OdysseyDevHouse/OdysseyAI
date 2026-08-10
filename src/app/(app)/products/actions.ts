'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import { toProductType } from '@/lib/productTypes'
import { toVariableType, toPriceCalc } from '@/lib/productProperties'
import { linkedStores } from '@/lib/storeGroups'
import { setShareSettings } from '@/lib/site/shareSettings'
import { fanoutProduct } from '@/lib/site/productFanout'
import { setGroupsForProduct } from '@/lib/site/instructions'
import { saveLocationLevels } from '@/lib/site/stockLocations'
import { listPriceStructures, listVatRates } from '@/lib/site/lookups'
import {
  createProduct,
  updateProduct,
  setArchived,
  deleteProduct,
  propertyColumnMap,
  type ProductInput,
} from '@/lib/site/products'
import {
  saveRecipe,
  saveRefer,
  clearRefer,
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

  const result = idRaw
    ? await updateProduct(siteId, Number(idRaw), input)
    : await createProduct(siteId, input)

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
  }

  if (productType === 'refer') {
    const targetRaw = String(form.get('referTarget') ?? '').trim()
    if (targetRaw) {
      const refer = await saveRefer(siteId, result.id, Number(targetRaw), num(form, 'referFactor'))
      if (!refer.ok) return { error: refer.error }
      // An empty target is the panel saying "unlinked", which is distinct from
      // the field being absent because the tab never rendered.
    } else if (form.get('referTarget') !== null) {
      await clearRefer(siteId, result.id)
    }
  }

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
      },
      structures.map((s) => ({ id: s.id, name: s.name })),
      availability,
    ).catch(() => [])
  }

  revalidatePath('/products')
  redirect(`/products/${result.id}?saved=1`)
}

export async function archiveProductAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('products.edit')
  const { siteId } = ctx
  const id = Number(form.get('id'))
  const archived = String(form.get('archived')) === '1'

  if (Number.isFinite(id) && id > 0) await setArchived(siteId, id, archived)

  revalidatePath('/products')
  redirect(`/products/${id}`)
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

  if (!result.ok) {
    redirect(`/products/${id}?error=${encodeURIComponent(result.error)}`)
  }

  // A product with sales history is archived rather than deleted. Say so:
  // silently doing something other than what was asked is worse than refusing.
  if (result.archived) {
    redirect(`/products/${id}?archived=1&reason=${encodeURIComponent(result.reason)}`)
  }

  redirect('/products?deleted=1')
}

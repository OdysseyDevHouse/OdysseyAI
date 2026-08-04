'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { toProductType } from '@/lib/productTypes'
import { linkedStores } from '@/lib/storeGroups'
import { setShareSettings } from '@/lib/site/shareSettings'
import { fanoutProduct } from '@/lib/site/productFanout'
import { listPriceStructures, listVatRates } from '@/lib/site/lookups'
import {
  createProduct,
  updateProduct,
  setArchived,
  deleteProduct,
  type ProductInput,
} from '@/lib/site/products'

export type ProductFormState = { error: string | null }

function num(form: FormData, key: string): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return 0
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
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

function readInput(form: FormData): ProductInput {
  return {
    code: String(form.get('code') ?? ''),
    barcode: String(form.get('barcode') ?? '') || null,
    description: String(form.get('description') ?? ''),
    // Sanitised server-side in lib/site/products.ts — never trusted from here.
    extraDescription: String(form.get('extraDescription') ?? '') || null,
    // Narrowed rather than trusted: an unknown value falls back to 'normal'.
    productType: toProductType(form.get('productType')),
    departmentId: optionalId(form, 'departmentId'),
    brandId: optionalId(form, 'brandId'),
    imageColor: String(form.get('imageColor') ?? '') || null,
    purchaseVatRateId: optionalId(form, 'purchaseVatRateId'),
    sellingVatRateId: optionalId(form, 'sellingVatRateId'),
    lastCost: num(form, 'lastCost'),
    openingStock: num(form, 'openingStock'),
    minStock: num(form, 'minStock'),
    maxStock: num(form, 'maxStock'),
    isArchived: form.get('isArchived') === 'on',
    prices: readPrices(form),
    sharesCost: readShareFlag(form, 'sharesCost'),
    sharesSelling: readShareFlag(form, 'sharesSelling'),
  }
}

export async function saveProductAction(
  _prev: ProductFormState,
  form: FormData,
): Promise<ProductFormState> {
  const siteId = await requireSiteId()

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateProduct(siteId, Number(idRaw), input)
    : await createProduct(siteId, input)

  if (!result.ok) return { error: result.error }

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
        perStore: readPerStore(form),
        purchaseVatPercent: rateOf(input.purchaseVatRateId),
        sellingVatPercent: rateOf(input.sellingVatRateId),
      },
      structures.map((s) => ({ id: s.id, name: s.name })),
    ).catch(() => [])
  }

  revalidatePath('/products')
  redirect(`/products/${result.id}?saved=1`)
}

export async function archiveProductAction(form: FormData): Promise<void> {
  const siteId = await requireSiteId()
  const id = Number(form.get('id'))
  const archived = String(form.get('archived')) === '1'

  if (Number.isFinite(id) && id > 0) await setArchived(siteId, id, archived)

  revalidatePath('/products')
  redirect(`/products/${id}`)
}

export async function deleteProductAction(form: FormData): Promise<void> {
  const siteId = await requireSiteId()
  const id = Number(form.get('id'))

  if (Number.isFinite(id) && id > 0) await deleteProduct(siteId, id)

  revalidatePath('/products')
  redirect('/products')
}

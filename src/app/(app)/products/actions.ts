'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
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

/** Selling prices arrive as price_<structureId> fields. */
function readPrices(form: FormData): Record<number, number> {
  const prices: Record<number, number> = {}
  for (const [key, value] of form.entries()) {
    const match = /^price_(\d+)$/.exec(key)
    if (!match) continue
    const n = Number(String(value).replace(/,/g, ''))
    prices[Number(match[1])] = Number.isFinite(n) ? n : 0
  }
  return prices
}

function readInput(form: FormData): ProductInput {
  return {
    code: String(form.get('code') ?? ''),
    barcode: String(form.get('barcode') ?? '') || null,
    description: String(form.get('description') ?? ''),
    // Sanitised server-side in lib/site/products.ts — never trusted from here.
    extraDescription: String(form.get('extraDescription') ?? '') || null,
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

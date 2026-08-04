'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSession, requireStoreId, canEdit } from '@/lib/auth'
import { createProduct, updateProduct, deactivateProduct, type ProductInput } from '@/lib/products'

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

function readInput(form: FormData): ProductInput {
  return {
    sku: String(form.get('sku') ?? ''),
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? '') || null,
    departmentId: optionalId(form, 'departmentId'),
    supplierId: optionalId(form, 'supplierId'),
    vatRateId: optionalId(form, 'vatRateId'),
    unit: String(form.get('unit') ?? 'each'),
    costPrice: num(form, 'costPrice'),
    sellingPrice: num(form, 'sellingPrice'),
    trackStock: form.get('trackStock') === 'on',
    stockOnHand: num(form, 'stockOnHand'),
    reorderLevel: num(form, 'reorderLevel'),
    reorderQty: num(form, 'reorderQty'),
    isActive: form.get('isActive') === 'on',
    barcodes: String(form.get('barcode') ?? '').trim()
      ? [{ barcode: String(form.get('barcode')).trim(), isPrimary: true }]
      : [],
  }
}

export async function saveProductAction(
  _prev: ProductFormState,
  form: FormData,
): Promise<ProductFormState> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) return { error: 'You do not have permission to edit products.' }

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateProduct(storeId, session.userId, Number(idRaw), input)
    : await createProduct(storeId, session.userId, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/products')
  revalidatePath('/dashboard')
  redirect(`/products/${result.id}`)
}

export async function deactivateProductAction(form: FormData): Promise<void> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) redirect('/products')

  const id = Number(form.get('id'))
  if (Number.isFinite(id) && id > 0) {
    await deactivateProduct(storeId, session.userId, id)
  }

  revalidatePath('/products')
  redirect('/products')
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  addProductBarcode,
  removeProductBarcode,
} from '@/lib/site/productBarcodes'

/** Alias barcodes on a product — the panel's two verbs. */

export async function addBarcodeAction(
  productId: number,
  barcode: string,
  note?: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await addProductBarcode(ctx.siteId, productId, barcode, note ?? null)
  if (!result.ok) return result

  revalidatePath(`/products/${productId}`)
  return result
}

export async function removeBarcodeAction(
  productId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  await removeProductBarcode(ctx.siteId, id)
  revalidatePath(`/products/${productId}`)
  return { ok: true }
}

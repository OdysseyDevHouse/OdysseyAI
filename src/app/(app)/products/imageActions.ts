'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  addImage,
  deleteImage,
  listImages,
  reorderImages,
  setAltText,
  setPrimaryImage,
  type ProductImage,
  type SaveResult,
} from '@/lib/site/productImages'

/**
 * Managing a product's photographs.
 *
 * Its own file rather than products/actions.ts: that one is about the product
 * RECORD and runs through the same validate-and-save path for every field.
 * These are file operations with their own failure modes, and mixing them in
 * would mean every product save carried upload handling it never uses.
 */

export type ImagesResult =
  | { ok: true; images: ProductImage[] }
  | { ok: false; error: string }

/** Upload one image. The file itself is validated in storeImageUpload. */
export async function uploadImageAction(
  productId: number,
  formData: FormData,
): Promise<ImagesResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const file = formData.get('file')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await addImage(siteId, productId, file, String(formData.get('alt') ?? ''))
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: productId,
    action: 'image_added',
    detail: `Image “${result.image.filename}” added`,
  })

  revalidatePath(`/products/${productId}`)
  return { ok: true, images: await listImages(siteId, productId) }
}

export async function deleteImageAction(
  productId: number,
  imageId: number,
): Promise<ImagesResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteImage(siteId, productId, imageId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: productId,
    action: 'image_removed',
    detail: 'Image removed',
  })

  revalidatePath(`/products/${productId}`)
  return { ok: true, images: await listImages(siteId, productId) }
}

export async function setPrimaryImageAction(
  productId: number,
  imageId: number,
): Promise<ImagesResult> {
  const { siteId } = await requireActor()
  const result = await setPrimaryImage(siteId, productId, imageId)
  if (!result.ok) return result

  revalidatePath(`/products/${productId}`)
  return { ok: true, images: await listImages(siteId, productId) }
}

export async function reorderImagesAction(
  productId: number,
  orderedIds: number[],
): Promise<ImagesResult> {
  const { siteId } = await requireActor()
  const result = await reorderImages(siteId, productId, orderedIds)
  if (!result.ok) return result

  revalidatePath(`/products/${productId}`)
  return { ok: true, images: await listImages(siteId, productId) }
}

export async function setAltTextAction(
  productId: number,
  imageId: number,
  altText: string,
): Promise<SaveResult> {
  const { siteId } = await requireActor()
  const result = await setAltText(siteId, productId, imageId, altText)
  if (result.ok) revalidatePath(`/products/${productId}`)
  return result
}

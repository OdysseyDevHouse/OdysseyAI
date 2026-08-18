'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { setSetting } from '@/lib/site/settings'
import {
  addImage,
  clearIcon,
  deleteImage,
  listImages,
  reorderImages,
  setAltText,
  setIcon,
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

/* ── The till icon ───────────────────────────────────────────────────────────
 *
 * Separate actions from the photographs above, because the icon is a different thing
 * with a different shape: one file on the product row rather than a row in
 * product_images. See the note in productImages.ts.
 *
 * Same `products.edit` guard. Whoever may change what a product costs may change what
 * its till key looks like — a second capability for a picture would be ceremony.
 */

export type IconResult = { ok: true; storedName: string } | { ok: false; error: string }

/**
 * Sets a product's till icon.
 *
 * Returns the stored name so the panel can repoint its preview immediately. It cannot
 * derive that itself — the name is assigned by `storeImageUpload` after it has verified
 * the bytes — and re-reading the product just to learn it would be a second round trip
 * for something the write already knows.
 */
export async function uploadProductIconAction(
  productId: number,
  formData: FormData,
): Promise<IconResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const file = formData.get('file')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await setIcon(siteId, productId, file)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: productId,
    action: 'icon_set',
    detail: 'Till icon updated',
  })

  revalidatePath(`/products/${productId}`)
  return result
}

export async function removeProductIconAction(productId: number): Promise<SaveResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await clearIcon(siteId, productId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: productId,
    action: 'icon_removed',
    detail: 'Till icon removed',
  })

  revalidatePath(`/products/${productId}`)
  return { ok: true }
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

/* ── The generated-icon typeface ─────────────────────────────────────────────
 *
 * Site-wide, but written from the product screen while generating a till icon,
 * so it lives with the icon actions above rather than in the settings screen's
 * own file.
 *
 * GUARDED ON products.edit, deliberately — NOT a settings capability. The value
 * is global, but it is saved as a side effect of generating an icon for one
 * product: a buyer with product rights must be able to use the generator
 * without also holding settings rights, which in most shops is manager-only.
 */

export async function setGeneratePictureFontAction(
  font: string,
): Promise<SaveResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  // validateSetting rejects anything that is not a PICTURE_FONTS id, so an
  // unknown value never reaches the table.
  return setSetting(ctx.siteId, 'generate_picture_font', font)
}

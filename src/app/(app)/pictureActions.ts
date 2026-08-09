'use server'

import { revalidatePath } from 'next/cache'
import { actorForAny } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  addStorefrontImage,
  deleteStorefrontImage,
  listStorefrontImages,
  type SaveResult,
  type StorefrontImage,
} from '@/lib/site/storefrontImages'

/**
 * The shop's picture library, for every screen that puts a picture on something.
 *
 * ── WHY THESE ARE NOT THE BUILDER'S ACTIONS ──────────────────────────────
 *
 * The builder's copies guard on `online.edit`, which is right for a front-page
 * banner and wrong for a DEPARTMENT: departments are edited under
 * `products.edit` by someone who may have no online-store rights at all. Reusing
 * them would have handed that person an empty picker and an upload that failed
 * with a permission error — the picker would have looked broken rather than
 * forbidden.
 *
 * ── WHY EITHER CAPABILITY, AND WHY THAT IS NOT A HOLE ────────────────────
 *
 * One library, reached from two screens, so the guard is "may edit the things
 * pictures go on" — either capability, not both. That grants no one anything
 * new: `products.edit` already lets you upload product photographs, and
 * `online.edit` already lets you upload banners. The bytes are the same kind of
 * bytes, verified by the same magic-byte check, served by the same two routes.
 *
 * What it deliberately does NOT do is let a user with neither capability touch
 * the library at all.
 */

/** Whoever may put a picture on something, or a refusal. */
const pictureActor = () => actorForAny('products.edit', 'online.edit')

export async function listPicturesAction(): Promise<StorefrontImage[]> {
  const ctx = await pictureActor()
  // An empty list is the honest answer for someone not allowed to look, and
  // this feeds a picker that must not throw at it.
  if ('ok' in ctx) return []
  return listStorefrontImages(ctx.siteId)
}

/**
 * Upload a picture.
 *
 * Takes FormData rather than a File so the browser can post the bytes through
 * a plain server action — `storeImageUpload` verifies the magic bytes before
 * anything reaches the disk, so a renamed SVG never becomes a stored file.
 */
export async function uploadPictureAction(
  form: FormData,
): Promise<{ ok: true; image: StorefrontImage } | { ok: false; error: string }> {
  const ctx = await pictureActor()
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a picture to upload.' }
  }

  const result = await addStorefrontImage(siteId, file, String(form.get('altText') ?? ''))
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'image',
    detail: `Picture uploaded: ${result.image.filename}`,
  })

  // Both screens that draw from this library, because either may be the one
  // showing a stale list.
  revalidatePath('/online-store/builder')
  revalidatePath('/departments', 'layout')
  return result
}

/**
 * Delete a picture.
 *
 * Whatever still names it is deliberately NOT rewritten. A banner's reference
 * lives inside the layout JSON and a department's in a column, and hunting
 * through every draft and every department to scrub it would make deleting a
 * picture into an edit nobody asked for. Both readers resolve a missing id to
 * nothing: the section draws a placeholder that says so in words, and the
 * department falls back to its colour and initial.
 */
export async function deletePictureAction(imageId: number): Promise<SaveResult> {
  const ctx = await pictureActor()
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteStorefrontImage(siteId, imageId)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'image',
    detail: 'Picture deleted',
  })

  revalidatePath('/online-store/builder')
  revalidatePath('/departments', 'layout')
  return result
}

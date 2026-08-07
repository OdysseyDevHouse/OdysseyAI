import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import { deleteStoredFile, storeImageUpload } from '../uploads'

/**
 * Pictures the owner puts on the shop's front page.
 *
 * The metadata half of the decision in 060_storefront_images.sql: the bytes
 * live on disk, this owns the rows, and lib/uploads.ts owns the file.
 *
 * Deliberately a thinner module than productImages.ts, because a banner has
 * none of that table's invariants — no primary flag to keep at exactly one, no
 * gallery order, no mirror column to sync. It is a library of pictures the
 * layout refers to by id.
 *
 * ── A DELETED IMAGE IS NOT AN ERROR ──────────────────────────────────────
 *
 * Nothing stops an owner deleting a picture some section still names: the
 * reference lives inside the layout JSON where no constraint reaches. Every
 * reader here therefore returns null rather than throwing for an id that is
 * gone, and the callers draw a plain band instead of a broken image.
 */

type Row = RowDataPacket & Record<string, unknown>

export type StorefrontImage = {
  id: number
  storedName: string
  filename: string
  mimeType: string
  sizeBytes: number
  altText: string
}

export type ImageResult = { ok: true; image: StorefrontImage } | { ok: false; error: string }
export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * How many pictures a shop may keep.
 *
 * A cap rather than none: these are never deleted automatically, and an
 * uploads directory that only grows is the kind of thing nobody notices until
 * the disk fills. Twelve sections' worth of banners with room to change one's
 * mind is far more than any front page needs.
 */
export const MAX_STOREFRONT_IMAGES = 40

function mapImage(r: Row): StorefrontImage {
  return {
    id: Number(r.id),
    storedName: String(r.stored_name),
    filename: String(r.filename),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes ?? 0),
    altText: String(r.alt_text ?? ''),
  }
}

/** Every picture in the shop's library, newest first — the picker's list. */
export async function listStorefrontImages(siteId: number): Promise<StorefrontImage[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM storefront_images ORDER BY created_at DESC, id DESC`,
  )
  return rows.map(mapImage)
}

/** One picture, or null when it no longer exists. */
export async function getStorefrontImage(
  siteId: number,
  imageId: number,
): Promise<StorefrontImage | null> {
  if (!Number.isInteger(imageId) || imageId <= 0) return null
  const row = await siteQueryOne<Row>(siteId, `SELECT * FROM storefront_images WHERE id = ?`, [
    imageId,
  ])
  return row ? mapImage(row) : null
}

/**
 * The pictures these sections refer to, keyed by id.
 *
 * Batched for the same reason as `primaryImages`: a front page can hold
 * several banners, and one query per section is several round trips to answer
 * one question. Ids that no longer resolve are simply absent from the map,
 * which is what lets a caller treat "deleted" and "never set" identically.
 */
export async function storefrontImagesByIds(
  siteId: number,
  imageIds: number[],
): Promise<Map<number, StorefrontImage>> {
  const wanted = [...new Set(imageIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (wanted.length === 0) return new Map()

  const placeholders = wanted.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM storefront_images WHERE id IN (${placeholders})`,
    wanted,
  )
  return new Map(rows.map((r) => [Number(r.id), mapImage(r)]))
}

/**
 * Store an uploaded picture and record it.
 *
 * Bytes first, row second — the same ordering and the same reasoning as
 * `addImage`: a failed insert leaves an orphaned file, which is invisible and
 * costs disk, rather than a row pointing at nothing, which is a broken image
 * on a customer's screen. The file is unlinked on the way out.
 */
export async function addStorefrontImage(
  siteId: number,
  file: File,
  altText = '',
): Promise<ImageResult> {
  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM storefront_images`,
  )
  if (Number(existing?.n ?? 0) >= MAX_STOREFRONT_IMAGES) {
    return {
      ok: false,
      error: `Your picture library holds ${MAX_STOREFRONT_IMAGES} images. Delete one to add another.`,
    }
  }

  // Verifies the magic bytes before anything is written, so an SVG or an HTML
  // page with a .png name never reaches the disk or this table.
  const stored = await storeImageUpload(file)
  if (!stored.ok) return stored

  try {
    const result = await siteExecute(
      siteId,
      `INSERT INTO storefront_images
         (stored_name, filename, mime_type, size_bytes, alt_text)
       VALUES (?,?,?,?,?)`,
      [
        stored.file.storedName,
        stored.file.filename,
        stored.file.mimeType,
        stored.file.sizeBytes,
        altText.slice(0, 190),
      ],
    )

    const row = await siteQueryOne<Row>(siteId, `SELECT * FROM storefront_images WHERE id = ?`, [
      result.insertId,
    ])
    if (!row) throw new Error('Image row vanished after insert.')
    return { ok: true, image: mapImage(row) }
  } catch (error) {
    await deleteStoredFile(stored.file.storedName)
    throw error
  }
}

/**
 * Remove a picture and its file.
 *
 * Sections still naming it are NOT rewritten — see the module header. The row
 * goes first so a failure to unlink leaks a file rather than blocking the
 * delete the owner asked for.
 */
export async function deleteStorefrontImage(
  siteId: number,
  imageId: number,
): Promise<SaveResult> {
  const image = await getStorefrontImage(siteId, imageId)
  if (!image) return { ok: false, error: 'That picture no longer exists.' }

  await siteExecute(siteId, `DELETE FROM storefront_images WHERE id = ?`, [imageId])
  await deleteStoredFile(image.storedName)
  return { ok: true }
}

export async function setStorefrontImageAlt(
  siteId: number,
  imageId: number,
  altText: string,
): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE storefront_images SET alt_text = ? WHERE id = ?`,
    [altText.slice(0, 190), imageId],
  )
  if (result.affectedRows === 0) return { ok: false, error: 'That picture no longer exists.' }
  return { ok: true }
}

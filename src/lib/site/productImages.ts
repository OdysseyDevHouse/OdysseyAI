import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { deleteStoredFile, storeImageUpload } from '../uploads'
import { MAX_IMAGES_PER_PRODUCT, type ProductImage } from '../productImageModel'

// Re-exported so a server caller has one import; the definitions live in the
// pure model, which the browser can also read.
export { MAX_IMAGES_PER_PRODUCT }
export type { ProductImage }

/**
 * Product photographs.
 *
 * The metadata half of the decision documented in 041_product_images.sql: the
 * bytes live on disk, this owns the rows, and lib/uploads.ts owns the file.
 *
 * ── THE PRIMARY IMAGE IS AN INVARIANT THIS MODULE KEEPS ──────────────────
 *
 * MySQL cannot express "at most one primary per product", so every write that
 * could break it does so inside a transaction: setting one clears the rest,
 * deleting the primary promotes the next, and the first image uploaded becomes
 * primary automatically. A product with two primaries renders differently
 * depending on row order — the kind of bug a customer notices before we do.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ImageResult = { ok: true; image: ProductImage } | { ok: false; error: string }
export type SaveResult = { ok: true } | { ok: false; error: string }

function mapImage(r: Row): ProductImage {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    storedName: String(r.stored_name),
    filename: String(r.filename),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes ?? 0),
    altText: String(r.alt_text ?? ''),
    sortOrder: Number(r.sort_order ?? 0),
    isPrimary: !!r.is_primary,
  }
}

export async function listImages(siteId: number, productId: number): Promise<ProductImage[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id`,
    [productId],
  )
  return rows.map(mapImage)
}

/**
 * The picture that represents each of these products, keyed by product id.
 *
 * Batched deliberately: a product grid renders 60 rows, and asking per row is
 * 60 queries for one screen. Falls back to the lowest-sorted image when
 * nothing is flagged primary, so a product always shows something if it has
 * anything at all.
 */
export async function primaryImages(
  siteId: number,
  productIds: number[],
): Promise<Map<number, ProductImage>> {
  if (productIds.length === 0) return new Map()

  const placeholders = productIds.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM product_images
      WHERE product_id IN (${placeholders})
      ORDER BY product_id, is_primary DESC, sort_order, id`,
    productIds,
  )

  const out = new Map<number, ProductImage>()
  for (const row of rows) {
    const image = mapImage(row)
    // The ORDER BY puts the winner first for each product, so the first one
    // seen is the one to keep.
    if (!out.has(image.productId)) out.set(image.productId, image)
  }
  return out
}

/** One image, but only if it belongs to the product named. */
export async function getImage(
  siteId: number,
  productId: number,
  imageId: number,
): Promise<ProductImage | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM product_images WHERE id = ? AND product_id = ?`,
    [imageId, productId],
  )
  return row ? mapImage(row) : null
}

/**
 * Store an uploaded image and record it.
 *
 * The bytes are written FIRST and the row second, so a failed insert leaves an
 * orphaned file rather than a row pointing at nothing. An orphan is invisible
 * and costs disk; a row whose file is missing is a broken image on a customer's
 * screen — so the failure is deliberately pushed to the harmless side, and the
 * file is unlinked on the way out.
 */
export async function addImage(
  siteId: number,
  productId: number,
  file: File,
  altText = '',
): Promise<ImageResult> {
  const existing = await listImages(siteId, productId)
  if (existing.length >= MAX_IMAGES_PER_PRODUCT) {
    return { ok: false, error: `A product can have ${MAX_IMAGES_PER_PRODUCT} images.` }
  }

  const stored = await storeImageUpload(file)
  if (!stored.ok) return stored

  try {
    const sortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((i) => i.sortOrder)) + 1
    // The first image a product gets is its primary. Nobody wants to upload a
    // photo and then be told to nominate it.
    const isPrimary = existing.length === 0

    const result = await siteExecute(
      siteId,
      `INSERT INTO product_images
         (product_id, stored_name, filename, mime_type, size_bytes, alt_text, sort_order, is_primary)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        productId,
        stored.file.storedName,
        stored.file.filename,
        stored.file.mimeType,
        stored.file.sizeBytes,
        altText.slice(0, 190),
        sortOrder,
        isPrimary ? 1 : 0,
      ],
    )

    const image = await siteQueryOne<Row>(
      siteId,
      `SELECT * FROM product_images WHERE id = ?`,
      [result.insertId],
    )
    if (!image) throw new Error('Image row vanished after insert.')

    // Keep products.image_path in step, so the till button and every screen
    // that predates this table show the same picture.
    if (isPrimary) await syncProductImagePath(siteId, productId, stored.file.storedName)

    return { ok: true, image: mapImage(image) }
  } catch (error) {
    await deleteStoredFile(stored.file.storedName)
    throw error
  }
}

/**
 * Remove an image, its file, and its primary flag.
 *
 * Deleting the primary promotes the next one rather than leaving the product
 * with none — a product with images but no primary would render a blank tile
 * in every grid.
 */
export async function deleteImage(
  siteId: number,
  productId: number,
  imageId: number,
): Promise<SaveResult> {
  const image = await getImage(siteId, productId, imageId)
  if (!image) return { ok: false, error: 'That image no longer exists.' }

  const promoted = await siteTransaction(siteId, async (tx) => {
    await tx.query(`DELETE FROM product_images WHERE id = ? AND product_id = ?`, [
      imageId,
      productId,
    ])

    if (!image.isPrimary) return null

    const [rows] = await tx.query<RowDataPacket[]>(
      `SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id LIMIT 1`,
      [productId],
    )
    const next = rows[0] as Row | undefined
    if (!next) return null

    await tx.query(`UPDATE product_images SET is_primary = 1 WHERE id = ?`, [next.id])
    return mapImage(next)
  })

  // After the row is gone, so a failure here leaks a file rather than blocking
  // the delete the user asked for.
  await deleteStoredFile(image.storedName)

  if (image.isPrimary) {
    await syncProductImagePath(siteId, productId, promoted?.storedName ?? null)
  }

  return { ok: true }
}

/** Nominate the image that represents this product. */
export async function setPrimaryImage(
  siteId: number,
  productId: number,
  imageId: number,
): Promise<SaveResult> {
  const image = await getImage(siteId, productId, imageId)
  if (!image) return { ok: false, error: 'That image no longer exists.' }

  await siteTransaction(siteId, async (tx) => {
    // Clear then set, in one transaction: the invariant is "at most one", and
    // doing it in two statements outside a transaction leaves a window where
    // there are two.
    await tx.query(`UPDATE product_images SET is_primary = 0 WHERE product_id = ?`, [productId])
    await tx.query(`UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ?`, [
      imageId,
      productId,
    ])
  })

  await syncProductImagePath(siteId, productId, image.storedName)
  return { ok: true }
}

/** Reorder a product's images. Ids not belonging to it are ignored. */
export async function reorderImages(
  siteId: number,
  productId: number,
  orderedIds: number[],
): Promise<SaveResult> {
  const owned = new Set((await listImages(siteId, productId)).map((i) => i.id))
  const valid = orderedIds.filter((id) => owned.has(id))
  if (valid.length === 0) return { ok: true }

  await siteTransaction(siteId, async (tx) => {
    for (const [index, id] of valid.entries()) {
      await tx.query(`UPDATE product_images SET sort_order = ? WHERE id = ? AND product_id = ?`, [
        index,
        id,
        productId,
      ])
    }
  })
  return { ok: true }
}

export async function setAltText(
  siteId: number,
  productId: number,
  imageId: number,
  altText: string,
): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    `UPDATE product_images SET alt_text = ? WHERE id = ? AND product_id = ?`,
    [altText.slice(0, 190), imageId, productId],
  )
  if (result.affectedRows === 0) return { ok: false, error: 'That image no longer exists.' }
  return { ok: true }
}

/**
 * Every stored file for a product, so a caller deleting the product can unlink
 * them. The rows go by CASCADE; the files cannot.
 */
export async function storedNamesFor(siteId: number, productId: number): Promise<string[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT stored_name FROM product_images WHERE product_id = ?`,
    [productId],
  )
  const names = rows.map((r) => String(r.stored_name))

  /* The till icon too. It is NOT a product_images row — see the icon section below —
     so a caller unlinking a deleted product's files would leave it on disk forever
     with nothing left in the database to name it. */
  const icon = await currentIcon(siteId, productId)
  if (icon && !names.includes(icon)) names.push(icon)

  return names
}

/* ── The till icon ───────────────────────────────────────────────────────────
 *
 * One picture on one button, stored as a name on the product itself
 * (`products.image_icon`) rather than as a `product_images` row.
 *
 * That is not an inconsistency. A photograph is merchandising: several per product,
 * ordered, with alt text, shown to shoppers. The icon is a single styled glyph on a
 * till key — there is exactly one, it has no order and no alt text, and it must not
 * appear in the online store as though it were a product photo. Modelling it as a row
 * in the photographs table would put it in every gallery that reads them.
 */

/** The stored file name of a product's till icon, or null. */
export async function currentIcon(siteId: number, productId: number): Promise<string | null> {
  const row = await siteQueryOne<Row>(siteId, `SELECT image_icon FROM products WHERE id = ?`, [
    productId,
  ])
  const name = row?.image_icon
  return name ? String(name) : null
}

/**
 * Replaces a product's till icon.
 *
 * The previous file is unlinked only AFTER the new name is committed. The other order
 * loses the old icon if the update fails, leaving a product pointing at a file that is
 * no longer there — and a broken till button is worse than a stale one.
 *
 * The bytes go through `storeImageUpload`, so magic-byte verification happens before
 * anything reaches the column. That is what lets the serving route derive its
 * Content-Type from the bytes in hand and never disagree with what is stored.
 */
export async function setIcon(
  siteId: number,
  productId: number,
  file: File,
): Promise<{ ok: true; storedName: string } | { ok: false; error: string }> {
  const previous = await currentIcon(siteId, productId)

  const stored = await storeImageUpload(file)
  if (!stored.ok) return stored

  try {
    await siteExecute(siteId, `UPDATE products SET image_icon = ? WHERE id = ?`, [
      stored.file.storedName,
      productId,
    ])
  } catch (error) {
    // Nothing was committed, so the new file is litter. Remove it rather than
    // leaving an orphan nothing will ever reference.
    await deleteStoredFile(stored.file.storedName)
    throw error
  }

  // Committed. Now the old one is safe to unlink — and a failure here costs an
  // orphaned file rather than a broken button, so it must not fail the save.
  if (previous && previous !== stored.file.storedName) {
    await deleteStoredFile(previous).catch(() => {})
  }

  return { ok: true, storedName: stored.file.storedName }
}

/** Removes a product's till icon, and its file. */
export async function clearIcon(siteId: number, productId: number): Promise<SaveResult> {
  const previous = await currentIcon(siteId, productId)
  if (!previous) return { ok: true }

  await siteExecute(siteId, `UPDATE products SET image_icon = NULL WHERE id = ?`, [productId])
  // Same order as above: the row first, the file second.
  await deleteStoredFile(previous).catch(() => {})
  return { ok: true }
}

/**
 * Mirror the primary image onto products.image_path.
 *
 * That column predates this table and is read by the till button and the
 * product list. Keeping it in step means those screens need no change, and a
 * store that never uploads a second photo behaves exactly as before.
 */
async function syncProductImagePath(
  siteId: number,
  productId: number,
  storedName: string | null,
): Promise<void> {
  await siteExecute(siteId, `UPDATE products SET image_path = ? WHERE id = ?`, [
    storedName,
    productId,
  ])
}

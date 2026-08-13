import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'

/**
 * Additional barcodes — the aliases a product answers to at a scanner.
 *
 * `products.barcode` stays the PRIMARY (every screen, the export, the labels
 * and the offline index read it); these are the extras: the 6-pack code, the
 * old supplier code. Strictly unique, which is what makes an alias scan
 * deterministic — and the reason a new alias is refused when it would shadow
 * ANY other product's primary barcode or code.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ProductBarcode = {
  id: number
  productId: number
  barcode: string
  note: string | null
}

export async function listProductBarcodes(
  siteId: number,
  productId: number,
): Promise<ProductBarcode[]> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT id, product_id, barcode, note FROM product_barcodes WHERE product_id = ? ORDER BY barcode',
    [productId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    productId: Number(r.product_id),
    barcode: String(r.barcode),
    note: (r.note as string | null) ?? null,
  }))
}

export type BarcodeResult = { ok: true; id: number } | { ok: false; error: string }

/** Names whatever already answers to this code, or null when it is free. */
async function clashFor(
  siteId: number,
  productId: number,
  barcode: string,
): Promise<string | null> {
  const alias = await siteQueryOne<Row>(
    siteId,
    `SELECT p.code, p.description FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
      WHERE pb.barcode = ? LIMIT 1`,
    [barcode],
  )
  if (alias) return `${String(alias.code)} — ${String(alias.description)} (extra barcode)`

  const primary = await siteQueryOne<Row>(
    siteId,
    `SELECT code, description FROM products
      WHERE (barcode = ? OR code = ?) AND id <> ? LIMIT 1`,
    [barcode, barcode, productId],
  )
  if (primary) return `${String(primary.code)} — ${String(primary.description)}`

  return null
}

export async function addProductBarcode(
  siteId: number,
  productId: number,
  barcode: string,
  note?: string | null,
): Promise<BarcodeResult> {
  const code = barcode.trim()
  if (!code) return { ok: false, error: 'Type or scan the barcode.' }
  if (code.length > 48) return { ok: false, error: 'A barcode is at most 48 characters.' }

  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT barcode, code FROM products WHERE id = ? LIMIT 1',
    [productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }
  if (String(product.barcode ?? '') === code || String(product.code) === code) {
    return { ok: false, error: 'That is already this product’s main barcode or code.' }
  }

  const holder = await clashFor(siteId, productId, code)
  if (holder) {
    return { ok: false, error: `${code} already answers to ${holder}.` }
  }

  try {
    const res = await siteExecute(
      siteId,
      'INSERT INTO product_barcodes (product_id, barcode, note) VALUES (?,?,?)',
      [productId, code, note?.trim().slice(0, 60) || null],
    )
    // The offline catalog's delta watches products.updated_at — an alias that
    // never touched the product row would never reach a till.
    await siteExecute(siteId, 'UPDATE products SET updated_at = NOW() WHERE id = ?', [productId])
    return { ok: true, id: res.insertId }
  } catch {
    // The unique index raced us — same message, read back for the name.
    const late = await clashFor(siteId, productId, code)
    return { ok: false, error: `${code} already answers to ${late ?? 'another product'}.` }
  }
}

export async function removeProductBarcode(siteId: number, id: number): Promise<void> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT product_id FROM product_barcodes WHERE id = ? LIMIT 1',
    [id],
  )
  await siteExecute(siteId, 'DELETE FROM product_barcodes WHERE id = ?', [id])
  if (row) {
    // Same delta-visibility rule as adding one.
    await siteExecute(siteId, 'UPDATE products SET updated_at = NOW() WHERE id = ?', [
      Number(row.product_id),
    ])
  }
}

/**
 * Replace-set, for the import: the file's list becomes the whole list.
 * Refusals collect as warnings — the product itself was already written, and
 * a duplicate alias must not fail the row that carried it.
 */
export async function setProductBarcodes(
  siteId: number,
  productId: number,
  barcodes: string[],
): Promise<{ warnings: string[] }> {
  const warnings: string[] = []
  const wanted = [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))]

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_barcodes WHERE product_id = ?', [productId] as never)
    // Even a clearing write must reach the offline delta.
    await tx.execute('UPDATE products SET updated_at = NOW() WHERE id = ?', [productId] as never)
  })

  for (const code of wanted) {
    const result = await addProductBarcode(siteId, productId, code)
    if (!result.ok) warnings.push(result.error)
  }
  return { warnings }
}

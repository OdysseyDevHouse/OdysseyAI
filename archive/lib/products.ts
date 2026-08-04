import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute, transaction } from './db'
import { toNum, marginPercent } from './decimals'

export type ProductRow = RowDataPacket & {
  id: number
  sku: string
  name: string
  description: string | null
  department_id: number | null
  department_name: string | null
  supplier_id: number | null
  supplier_name: string | null
  vat_rate_id: number | null
  vat_rate: string | null
  unit: string
  cost_price: string
  selling_price: string
  track_stock: number
  stock_on_hand: string
  reorder_level: string
  reorder_qty: string
  is_active: number
  primary_barcode: string | null
}

export type Product = {
  id: number
  sku: string
  name: string
  description: string | null
  departmentId: number | null
  departmentName: string | null
  supplierId: number | null
  supplierName: string | null
  vatRateId: number | null
  vatRate: number
  unit: string
  costPrice: number
  sellingPrice: number
  trackStock: boolean
  stockOnHand: number
  reorderLevel: number
  reorderQty: number
  isActive: boolean
  primaryBarcode: string | null
  /** Derived, not stored — recomputing keeps it honest when cost or VAT moves. */
  marginPercent: number
}

function mapProduct(r: ProductRow): Product {
  const cost = toNum(r.cost_price)
  const sell = toNum(r.selling_price)
  const vat = toNum(r.vat_rate)
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    departmentId: r.department_id,
    departmentName: r.department_name,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    vatRateId: r.vat_rate_id,
    vatRate: vat,
    unit: r.unit,
    costPrice: cost,
    sellingPrice: sell,
    trackStock: !!r.track_stock,
    stockOnHand: toNum(r.stock_on_hand),
    reorderLevel: toNum(r.reorder_level),
    reorderQty: toNum(r.reorder_qty),
    isActive: !!r.is_active,
    primaryBarcode: r.primary_barcode,
    marginPercent: marginPercent(cost, sell, vat),
  }
}

const SELECT_PRODUCT = `
  SELECT p.id, p.sku, p.name, p.description, p.department_id, p.supplier_id,
         p.vat_rate_id, p.unit, p.cost_price, p.selling_price, p.track_stock,
         p.stock_on_hand, p.reorder_level, p.reorder_qty, p.is_active,
         d.name  AS department_name,
         s.name  AS supplier_name,
         v.rate  AS vat_rate,
         (SELECT b.barcode FROM product_barcodes b
           WHERE b.product_id = p.id ORDER BY b.is_primary DESC, b.id ASC LIMIT 1) AS primary_barcode
    FROM products p
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN suppliers   s ON s.id = p.supplier_id
    LEFT JOIN vat_rates   v ON v.id = p.vat_rate_id
`

export type ProductListOptions = {
  search?: string
  departmentId?: number
  supplierId?: number
  includeInactive?: boolean
  lowStockOnly?: boolean
  limit?: number
  offset?: number
}

export type ProductList = { items: Product[]; total: number }

export async function listProducts(
  storeId: number,
  opts: ProductListOptions = {},
): Promise<ProductList> {
  const where: string[] = ['p.store_id = ?']
  const params: unknown[] = [storeId]

  if (!opts.includeInactive) where.push('p.is_active = 1')

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push(`(p.name LIKE ? OR p.sku LIKE ? OR EXISTS (
                   SELECT 1 FROM product_barcodes b
                    WHERE b.product_id = p.id AND b.barcode = ?))`)
    // Barcode matches exactly: a scanner sends the whole code, and a LIKE here
    // would make every scan a full scan of the barcode table.
    params.push(term, term, opts.search.trim())
  }
  if (opts.departmentId) {
    where.push('p.department_id = ?')
    params.push(opts.departmentId)
  }
  if (opts.supplierId) {
    where.push('p.supplier_id = ?')
    params.push(opts.supplierId)
  }
  if (opts.lowStockOnly) {
    where.push('p.track_stock = 1 AND p.stock_on_hand <= p.reorder_level')
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const rows = await query<ProductRow>(
    `${SELECT_PRODUCT} ${whereSql} ORDER BY p.name ASC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM products p ${whereSql}`,
    params,
  )

  return { items: rows.map(mapProduct), total: countRow?.total ?? 0 }
}

export async function getProduct(storeId: number, id: number): Promise<Product | null> {
  const row = await queryOne<ProductRow>(
    `${SELECT_PRODUCT} WHERE p.store_id = ? AND p.id = ? LIMIT 1`,
    [storeId, id],
  )
  return row ? mapProduct(row) : null
}

export async function findByBarcode(storeId: number, barcode: string): Promise<Product | null> {
  const row = await queryOne<ProductRow>(
    `${SELECT_PRODUCT}
      INNER JOIN product_barcodes pb ON pb.product_id = p.id
      WHERE p.store_id = ? AND pb.barcode = ? LIMIT 1`,
    [storeId, barcode],
  )
  return row ? mapProduct(row) : null
}

export type ProductInput = {
  sku: string
  name: string
  description?: string | null
  departmentId?: number | null
  supplierId?: number | null
  vatRateId?: number | null
  unit?: string
  costPrice?: number
  sellingPrice?: number
  trackStock?: boolean
  stockOnHand?: number
  reorderLevel?: number
  reorderQty?: number
  isActive?: boolean
  barcodes?: { barcode: string; packSize?: number; isPrimary?: boolean }[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateProduct(input: ProductInput): string | null {
  if (!input.sku?.trim()) return 'A product code is required.'
  if (input.sku.trim().length > 48) return 'Product code must be 48 characters or fewer.'
  if (!input.name?.trim()) return 'A product name is required.'
  if (input.name.trim().length > 190) return 'Product name must be 190 characters or fewer.'
  if ((input.costPrice ?? 0) < 0) return 'Cost price cannot be negative.'
  if ((input.sellingPrice ?? 0) < 0) return 'Selling price cannot be negative.'
  return null
}

export async function createProduct(
  storeId: number,
  userId: number,
  input: ProductInput,
): Promise<SaveResult> {
  const invalid = validateProduct(input)
  if (invalid) return { ok: false, error: invalid }

  const sku = input.sku.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM products WHERE store_id = ? AND sku = ? LIMIT 1',
    [storeId, sku],
  )
  if (clash) return { ok: false, error: `Product code "${sku}" is already in use.` }

  return transaction(async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO products
         (store_id, sku, name, description, department_id, supplier_id, vat_rate_id,
          unit, cost_price, selling_price, track_stock, stock_on_hand,
          reorder_level, reorder_qty, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId,
        sku,
        input.name.trim(),
        input.description?.trim() || null,
        input.departmentId ?? null,
        input.supplierId ?? null,
        input.vatRateId ?? null,
        input.unit?.trim() || 'each',
        (input.costPrice ?? 0).toFixed(4),
        (input.sellingPrice ?? 0).toFixed(4),
        input.trackStock === false ? 0 : 1,
        (input.stockOnHand ?? 0).toFixed(3),
        (input.reorderLevel ?? 0).toFixed(3),
        (input.reorderQty ?? 0).toFixed(3),
        input.isActive === false ? 0 : 1,
      ],
    )
    const id = (res as { insertId: number }).insertId

    for (const [i, b] of (input.barcodes ?? []).entries()) {
      if (!b.barcode?.trim()) continue
      await tx.execute(
        `INSERT INTO product_barcodes (store_id, product_id, barcode, pack_size, is_primary)
         VALUES (?,?,?,?,?)`,
        [
          storeId,
          id,
          b.barcode.trim(),
          (b.packSize ?? 1).toFixed(3),
          (b.isPrimary ?? i === 0) ? 1 : 0,
        ],
      )
    }

    await tx.execute(
      `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
       VALUES (?,?,'product',?, 'create', ?)`,
      [storeId, userId, id, `${sku} — ${input.name.trim()}`],
    )

    return { ok: true as const, id }
  })
}

export async function updateProduct(
  storeId: number,
  userId: number,
  id: number,
  input: ProductInput,
): Promise<SaveResult> {
  const invalid = validateProduct(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getProduct(storeId, id)
  if (!existing) return { ok: false, error: 'Product not found.' }

  const sku = input.sku.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM products WHERE store_id = ? AND sku = ? AND id <> ? LIMIT 1',
    [storeId, sku, id],
  )
  if (clash) return { ok: false, error: `Product code "${sku}" is already in use.` }

  await execute(
    `UPDATE products SET
       sku = ?, name = ?, description = ?, department_id = ?, supplier_id = ?,
       vat_rate_id = ?, unit = ?, cost_price = ?, selling_price = ?, track_stock = ?,
       reorder_level = ?, reorder_qty = ?, is_active = ?
     WHERE store_id = ? AND id = ?`,
    [
      sku,
      input.name.trim(),
      input.description?.trim() || null,
      input.departmentId ?? null,
      input.supplierId ?? null,
      input.vatRateId ?? null,
      input.unit?.trim() || 'each',
      (input.costPrice ?? 0).toFixed(4),
      (input.sellingPrice ?? 0).toFixed(4),
      input.trackStock === false ? 0 : 1,
      (input.reorderLevel ?? 0).toFixed(3),
      (input.reorderQty ?? 0).toFixed(3),
      input.isActive === false ? 0 : 1,
      storeId,
      id,
    ],
  )
  // stock_on_hand is deliberately not settable here — it moves through
  // adjustStock() so every change leaves an audit line.

  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'product',?, 'update', ?)`,
    [storeId, userId, id, `${sku} — ${input.name.trim()}`],
  )

  return { ok: true, id }
}

/** Soft delete. Products are referenced by history, so rows are never removed. */
export async function deactivateProduct(
  storeId: number,
  userId: number,
  id: number,
): Promise<void> {
  await execute('UPDATE products SET is_active = 0 WHERE store_id = ? AND id = ?', [storeId, id])
  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'product',?, 'deactivate', NULL)`,
    [storeId, userId, id],
  )
}

export async function adjustStock(
  storeId: number,
  userId: number,
  id: number,
  delta: number,
  reason: string,
): Promise<void> {
  await execute(
    `UPDATE products SET stock_on_hand = stock_on_hand + ?
      WHERE store_id = ? AND id = ? AND track_stock = 1`,
    [delta.toFixed(3), storeId, id],
  )
  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'product',?, 'stock_adjust', ?)`,
    [storeId, userId, id, `${delta > 0 ? '+' : ''}${delta} — ${reason}`],
  )
}

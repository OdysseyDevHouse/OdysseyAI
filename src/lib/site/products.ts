import 'server-only'
import type { RowDataPacket, PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { sanitiseHtml } from '../html'
import { costLine, priceLine, type CostBasis, type CostLine, type PriceLine } from '../pricing'
import { listVatRates, defaultVat, getCostBasis, type VatRate } from './lookups'

export type Product = {
  id: number
  code: string
  barcode: string | null
  description: string
  extraDescription: string | null
  productType: string

  departmentId: number | null
  brandId: number | null

  imagePath: string | null
  imageIcon: string | null
  imageColor: string | null

  purchaseVatRateId: number | null
  sellingVatRateId: number | null
  purchaseVatPercent: number
  sellingVatPercent: number

  lastCost: number
  averageCost: number

  stockOnHand: number
  minStock: number
  maxStock: number

  isArchived: boolean

  lastEditDate: Date | null
  lastPurchaseDate: Date | null
  lastSoldDate: Date | null
  lastAdjustDate: Date | null

  /** Derived, never stored. */
  cost: CostLine
  prices: ProductPrice[]
}

export type ProductPrice = {
  priceStructureId: number
  structureName: string
  position: number
  isDefault: boolean
} & PriceLine

type ProductRow = RowDataPacket & Record<string, unknown>

const SELECT_PRODUCT = `
  SELECT p.id, p.code, p.barcode, p.description, p.extra_description, p.product_type,
         p.department_id, p.brand_id, p.image_path, p.image_icon, p.image_color,
         p.purchase_vat_rate_id, p.selling_vat_rate_id,
         p.last_cost, p.average_cost,
         p.stock_on_hand, p.min_stock, p.max_stock, p.is_archived,
         p.last_edit_date, p.last_purchase_date, p.last_sold_date, p.last_adjust_date,
         pv.rate AS purchase_vat_rate, sv.rate AS selling_vat_rate
    FROM products p
    LEFT JOIN vat_rates pv ON pv.id = p.purchase_vat_rate_id
    LEFT JOIN vat_rates sv ON sv.id = p.selling_vat_rate_id
`

function mapProduct(
  r: ProductRow,
  basis: CostBasis,
  prices: { structureId: number; name: string; position: number; isDefault: boolean; incl: number }[],
): Product {
  const purchaseVat = toNum(r.purchase_vat_rate)
  const sellingVat = toNum(r.selling_vat_rate)
  const cost = costLine(r.average_cost, r.last_cost, purchaseVat, basis)

  return {
    id: Number(r.id),
    code: String(r.code),
    barcode: (r.barcode as string | null) ?? null,
    description: String(r.description),
    extraDescription: (r.extra_description as string | null) ?? null,
    productType: String(r.product_type),

    departmentId: r.department_id === null ? null : Number(r.department_id),
    brandId: r.brand_id === null ? null : Number(r.brand_id),

    imagePath: (r.image_path as string | null) ?? null,
    imageIcon: (r.image_icon as string | null) ?? null,
    imageColor: (r.image_color as string | null) ?? null,

    purchaseVatRateId: r.purchase_vat_rate_id === null ? null : Number(r.purchase_vat_rate_id),
    sellingVatRateId: r.selling_vat_rate_id === null ? null : Number(r.selling_vat_rate_id),
    purchaseVatPercent: purchaseVat,
    sellingVatPercent: sellingVat,

    lastCost: cost.lastCost,
    averageCost: cost.averageCost,

    stockOnHand: toNum(r.stock_on_hand),
    minStock: toNum(r.min_stock),
    maxStock: toNum(r.max_stock),

    isArchived: !!r.is_archived,

    lastEditDate: (r.last_edit_date as Date | null) ?? null,
    lastPurchaseDate: (r.last_purchase_date as Date | null) ?? null,
    lastSoldDate: (r.last_sold_date as Date | null) ?? null,
    lastAdjustDate: (r.last_adjust_date as Date | null) ?? null,

    cost,
    prices: prices.map((p) => ({
      priceStructureId: p.structureId,
      structureName: p.name,
      position: p.position,
      isDefault: p.isDefault,
      ...priceLine(p.incl, cost.effective, sellingVat),
    })),
  }
}

async function pricesFor(siteId: number, productIds: number[]) {
  if (productIds.length === 0) return new Map<number, ReturnType<typeof rowToPrice>[]>()

  // Every active structure appears for every product, even where no row exists
  // yet, so the edit form always renders a complete set of inputs.
  const placeholders = productIds.map(() => '?').join(',')
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    `SELECT ps.id AS structure_id, ps.name, ps.position, ps.is_default,
            p.id AS product_id, COALESCE(pp.selling_price_incl, 0) AS incl
       FROM price_structures ps
       CROSS JOIN products p
       LEFT JOIN product_prices pp
              ON pp.price_structure_id = ps.id AND pp.product_id = p.id
      WHERE ps.is_active = 1 AND p.id IN (${placeholders})
      ORDER BY p.id, ps.position`,
    productIds,
  )

  const byProduct = new Map<number, ReturnType<typeof rowToPrice>[]>()
  for (const raw of rows as unknown as Record<string, unknown>[]) {
    const productId = Number(raw.product_id)
    const list = byProduct.get(productId) ?? []
    list.push(rowToPrice(raw))
    byProduct.set(productId, list)
  }
  return byProduct
}

function rowToPrice(raw: Record<string, unknown>) {
  return {
    structureId: Number(raw.structure_id),
    name: String(raw.name),
    position: Number(raw.position),
    isDefault: !!raw.is_default,
    incl: toNum(raw.incl),
  }
}

export type ProductListOptions = {
  search?: string
  departmentIds?: number[]
  brandId?: number
  includeArchived?: boolean
  belowMinimum?: boolean
  limit?: number
  offset?: number
}

export async function listProducts(
  siteId: number,
  opts: ProductListOptions = {},
): Promise<{ items: Product[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (!opts.includeArchived) where.push('p.is_archived = 0')

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    // Barcode matches exactly: a scanner sends the whole code, and a LIKE would
    // turn every scan into a full table scan.
    where.push('(p.description LIKE ? OR p.code LIKE ? OR p.barcode = ?)')
    params.push(term, term, opts.search.trim())
  }
  if (opts.departmentIds?.length) {
    where.push(`p.department_id IN (${opts.departmentIds.map(() => '?').join(',')})`)
    params.push(...opts.departmentIds)
  }
  if (opts.brandId) {
    where.push('p.brand_id = ?')
    params.push(opts.brandId)
  }
  if (opts.belowMinimum) where.push('p.stock_on_hand <= p.min_stock')

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const [rows, countRow, basis] = await Promise.all([
    siteQuery<ProductRow>(
      siteId,
      `${SELECT_PRODUCT} ${whereSql} ORDER BY p.description ASC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total FROM products p ${whereSql}`,
      params,
    ),
    getCostBasis(siteId),
  ])

  const priceMap = await pricesFor(siteId, rows.map((r) => Number(r.id)))

  return {
    items: rows.map((r) => mapProduct(r, basis, priceMap.get(Number(r.id)) ?? [])),
    total: countRow?.total ?? 0,
  }
}

export async function getProduct(siteId: number, id: number): Promise<Product | null> {
  const [row, basis] = await Promise.all([
    siteQueryOne<ProductRow>(siteId, `${SELECT_PRODUCT} WHERE p.id = ? LIMIT 1`, [id]),
    getCostBasis(siteId),
  ])
  if (!row) return null

  const priceMap = await pricesFor(siteId, [id])
  return mapProduct(row, basis, priceMap.get(id) ?? [])
}

export async function findByBarcode(siteId: number, barcode: string): Promise<Product | null> {
  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM products WHERE barcode = ? LIMIT 1',
    [barcode],
  )
  return row ? getProduct(siteId, row.id) : null
}

// ── Writes ──────────────────────────────────────────────────────────────

export type ProductInput = {
  code: string
  barcode?: string | null
  description: string
  extraDescription?: string | null
  departmentId?: number | null
  brandId?: number | null
  imagePath?: string | null
  imageIcon?: string | null
  imageColor?: string | null
  purchaseVatRateId?: number | null
  sellingVatRateId?: number | null
  lastCost?: number
  averageCost?: number
  openingStock?: number
  minStock?: number
  maxStock?: number
  isArchived?: boolean
  /** Selling price INCLUSIVE of VAT, keyed by price_structure id. */
  prices?: Record<number, number>
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateProduct(input: ProductInput): string | null {
  if (!input.code?.trim()) return 'A product code is required.'
  if (input.code.trim().length > 48) return 'Product code must be 48 characters or fewer.'
  if (!input.description?.trim()) return 'A description is required.'
  if (input.description.trim().length > 190) return 'Description must be 190 characters or fewer.'
  if ((input.lastCost ?? 0) < 0) return 'Cost cannot be negative.'
  if ((input.averageCost ?? 0) < 0) return 'Average cost cannot be negative.'
  if ((input.minStock ?? 0) < 0) return 'Minimum level cannot be negative.'
  if ((input.maxStock ?? 0) < 0) return 'Maximum level cannot be negative.'
  if (
    (input.maxStock ?? 0) > 0 &&
    (input.minStock ?? 0) > (input.maxStock ?? 0)
  ) {
    return 'Minimum level cannot be above the maximum level.'
  }
  for (const value of Object.values(input.prices ?? {})) {
    if (value < 0) return 'Selling prices cannot be negative.'
  }
  return null
}

/** VAT defaults, so a product is never saved with no rate at all. */
async function resolveVat(
  siteId: number,
  input: ProductInput,
): Promise<{ purchase: number | null; selling: number | null }> {
  let rates: VatRate[] | null = null
  const load = async () => (rates ??= await listVatRates(siteId))

  const purchase =
    input.purchaseVatRateId ?? (defaultVat(await load(), 'purchase')?.id ?? null)
  const selling = input.sellingVatRateId ?? (defaultVat(await load(), 'sales')?.id ?? null)

  return { purchase, selling }
}

async function writePrices(
  tx: PoolConnection,
  productId: number,
  prices: Record<number, number> | undefined,
) {
  for (const [structureId, incl] of Object.entries(prices ?? {})) {
    await tx.execute(
      `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
            VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
      [productId, Number(structureId), incl.toFixed(4)] as never,
    )
  }
}

export async function createProduct(
  siteId: number,
  input: ProductInput,
): Promise<SaveResult> {
  const invalid = validateProduct(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM products WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

  const vat = await resolveVat(siteId, input)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO products
         (code, barcode, description, extra_description, product_type,
          department_id, brand_id, image_path, image_icon, image_color,
          purchase_vat_rate_id, selling_vat_rate_id,
          last_cost, average_cost, stock_on_hand, min_stock, max_stock,
          is_archived, last_edit_date)
       VALUES (?,?,?,?, 'normal', ?,?,?,?,?, ?,?, ?,?,?,?,?, ?, NOW())`,
      [
        code,
        input.barcode?.trim() || null,
        input.description.trim(),
        sanitiseHtml(input.extraDescription) || null,
        input.departmentId ?? null,
        input.brandId ?? null,
        input.imagePath ?? null,
        input.imageIcon ?? null,
        input.imageColor ?? null,
        vat.purchase,
        vat.selling,
        (input.lastCost ?? 0).toFixed(4),
        // A brand-new product has no purchase history, so average cost starts
        // at whatever cost was entered rather than zero — otherwise the first
        // margin shown would be 100%.
        (input.averageCost ?? input.lastCost ?? 0).toFixed(4),
        (input.openingStock ?? 0).toFixed(3),
        (input.minStock ?? 0).toFixed(3),
        (input.maxStock ?? 0).toFixed(3),
        input.isArchived ? 1 : 0,
      ] as never,
    )
    const id = (res as { insertId: number }).insertId
    await writePrices(tx, id, input.prices)
    return { ok: true as const, id }
  })
}

export async function updateProduct(
  siteId: number,
  id: number,
  input: ProductInput,
): Promise<SaveResult> {
  const invalid = validateProduct(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM products WHERE code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `UPDATE products SET
         code = ?, barcode = ?, description = ?, extra_description = ?,
         department_id = ?, brand_id = ?,
         image_path = ?, image_icon = ?, image_color = ?,
         purchase_vat_rate_id = ?, selling_vat_rate_id = ?,
         last_cost = ?, min_stock = ?, max_stock = ?,
         is_archived = ?, last_edit_date = NOW()
       WHERE id = ?`,
      [
        code,
        input.barcode?.trim() || null,
        input.description.trim(),
        sanitiseHtml(input.extraDescription) || null,
        input.departmentId ?? null,
        input.brandId ?? null,
        input.imagePath ?? null,
        input.imageIcon ?? null,
        input.imageColor ?? null,
        input.purchaseVatRateId ?? null,
        input.sellingVatRateId ?? null,
        (input.lastCost ?? 0).toFixed(4),
        (input.minStock ?? 0).toFixed(3),
        (input.maxStock ?? 0).toFixed(3),
        input.isArchived ? 1 : 0,
        id,
      ] as never,
    )
    // average_cost and stock_on_hand are deliberately NOT settable here. Average
    // cost is a consequence of purchases and stock of movements; letting the
    // edit form overwrite either would silently falsify stock valuation.

    if ((res as { affectedRows: number }).affectedRows === 0) {
      const exists = await tx.execute('SELECT id FROM products WHERE id = ?', [id] as never)
      const rows = (exists as unknown as [RowDataPacket[]])[0]
      if (!rows?.length) throw new Error('Product not found.')
    }

    await writePrices(tx, id, input.prices)
    return { ok: true as const, id }
  }).catch((err) => ({ ok: false as const, error: (err as Error).message }))
}

export async function setArchived(
  siteId: number,
  id: number,
  archived: boolean,
): Promise<void> {
  await siteExecute(
    siteId,
    'UPDATE products SET is_archived = ?, last_edit_date = NOW() WHERE id = ?',
    [archived ? 1 : 0, id],
  )
}

export async function deleteProduct(siteId: number, id: number): Promise<void> {
  // product_prices cascades. Once sales history exists this should refuse and
  // archive instead — there is nothing referencing a product yet.
  await siteExecute(siteId, 'DELETE FROM products WHERE id = ?', [id])
}

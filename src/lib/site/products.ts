import 'server-only'
import type { RowDataPacket, PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { sanitiseHtml } from '../html'
import { costLine, priceLine, type CostBasis, type CostLine, type PriceLine } from '../pricing'
import { toProductType, type ProductTypeId } from '../productTypes'
import {
  toVariableType,
  toPriceCalc,
  type VariableTypeId,
  type PriceCalcId,
} from '../productProperties'
import { listVatRates, defaultVat, getCostBasis, type VatRate } from './lookups'

export type Product = {
  id: number
  code: string
  barcode: string | null
  description: string
  extraDescription: string | null
  productType: ProductTypeId

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

  /**
   * The site total, across every location.
   *
   * Reorder levels are deliberately NOT here: they live per location in
   * product_location_stock, because a level is only meaningful against the
   * stock it governs. Read them with locationStockFor().
   */
  stockOnHand: number

  /**
   * True when ANY location is at or below its own minimum.
   *
   * Computed by the same rule the `belowMinimum` filter uses, and derived in
   * SQL rather than on the page: with levels per room there is no product-level
   * figure a screen could compare against, and two copies of the rule would
   * eventually disagree about which rows the filter should have returned.
   */
  belowMinimum: boolean

  isArchived: boolean

  /* ── Properties: how the product behaves at the till ───────────────── */
  visibleInPos: boolean
  changeDescription: boolean
  askPriceAtSale: boolean
  allowFractions: boolean
  chargePctSubtotal: boolean
  nonGpProduct: boolean
  maxDiscountPct: number
  variableType: VariableTypeId
  priceCalc: PriceCalcId

  /* ── Weight and size ───────────────────────────────────────────────── */
  packWeight: number
  weightDescription: string
  packSize: number
  packDescription: string
  /** Physical size in millimetres. Zero means "not recorded". */
  lengthMm: number
  widthMm: number
  heightMm: number
  prepTimeMinutes: number

  /* ── Scale properties ──────────────────────────────────────────────── */
  scaleItem: boolean
  labelScaleItem: boolean
  fixedPriceScale: boolean
  expiresInDays: number

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

/**
 * "Running low" — one definition, used by both the filter and the flag.
 *
 * A product is low when ANY location is at or below its own minimum. A level
 * of zero is "no level set" rather than "reorder at zero"; without that guard
 * every room holding none of a product it has never carried would be
 * permanently low, which is most rows in the table.
 */
const BELOW_MINIMUM_SQL = `EXISTS (
  SELECT 1 FROM product_location_stock pls
   WHERE pls.product_id = p.id
     AND pls.min_stock > 0
     AND pls.stock_on_hand <= pls.min_stock
)`

const SELECT_PRODUCT = `
  SELECT p.id, p.code, p.barcode, p.description, p.extra_description, p.product_type,
         ${BELOW_MINIMUM_SQL} AS below_minimum,
         p.department_id, p.brand_id, p.image_path, p.image_icon, p.image_color,
         p.purchase_vat_rate_id, p.selling_vat_rate_id,
         p.last_cost, p.average_cost,
         p.stock_on_hand, p.is_archived,
         p.visible_in_pos, p.change_description, p.ask_price_at_sale,
         p.allow_fractions, p.charge_pct_subtotal, p.non_gp_product,
         p.max_discount_pct, p.variable_type, p.price_calc,
         p.pack_weight, p.weight_description, p.pack_size, p.pack_description,
         p.length_mm, p.width_mm, p.height_mm, p.prep_time_minutes,
         p.scale_item, p.label_scale_item, p.fixed_price_scale, p.expires_in_days,
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
    productType: toProductType(r.product_type),

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
    belowMinimum: !!r.below_minimum,

    isArchived: !!r.is_archived,

    visibleInPos: !!r.visible_in_pos,
    changeDescription: !!r.change_description,
    askPriceAtSale: !!r.ask_price_at_sale,
    allowFractions: !!r.allow_fractions,
    chargePctSubtotal: !!r.charge_pct_subtotal,
    nonGpProduct: !!r.non_gp_product,
    maxDiscountPct: toNum(r.max_discount_pct),
    variableType: toVariableType(r.variable_type),
    priceCalc: toPriceCalc(r.price_calc),

    packWeight: toNum(r.pack_weight),
    weightDescription: String(r.weight_description ?? 'Kg'),
    packSize: toNum(r.pack_size),
    packDescription: String(r.pack_description ?? 'None'),
    lengthMm: toNum(r.length_mm),
    widthMm: toNum(r.width_mm),
    heightMm: toNum(r.height_mm),
    prepTimeMinutes: Number(r.prep_time_minutes ?? 0),

    scaleItem: !!r.scale_item,
    labelScaleItem: !!r.label_scale_item,
    fixedPriceScale: !!r.fixed_price_scale,
    expiresInDays: Number(r.expires_in_days ?? 0),

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
  /*
   * "Running low" is a question about a ROOM, not about the business.
   *
   * This used to compare the site total against a site-wide level. With levels
   * per location that comparison cannot be written at all, and it was the
   * wrong question anyway: 500 in the warehouse and 2 on the shop floor is not
   * "well stocked", it is a shop about to run out.
   */
  if (opts.belowMinimum) where.push(BELOW_MINIMUM_SQL)

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

/** The few columns a picker needs, without the price and cost-basis joins. */
export type ProductPick = {
  id: number
  code: string
  description: string
  productType: ProductTypeId
  stockOnHand: number
  averageCost: number
}

/**
 * Type-ahead search for the recipe and refer pickers.
 *
 * Deliberately not `listProducts`: that fans out to every price structure and
 * the cost basis to build a full Product, and a picker firing on each keystroke
 * would run those joins for results the user never looks at.
 *
 * `exclude` drops the product being edited, so a recipe cannot list itself as an
 * ingredient. The save path refuses that too — this only keeps it off screen.
 */
export async function searchProductsForPicker(
  siteId: number,
  opts: { search?: string; exclude?: number; limit?: number } = {},
): Promise<ProductPick[]> {
  const where: string[] = ['p.is_archived = 0']
  const params: unknown[] = []

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(p.description LIKE ? OR p.code LIKE ? OR p.barcode = ?)')
    params.push(term, term, opts.search.trim())
  }
  if (opts.exclude) {
    where.push('p.id <> ?')
    params.push(opts.exclude)
  }

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT p.id, p.code, p.description, p.product_type, p.stock_on_hand, p.average_cost
       FROM products p
      WHERE ${where.join(' AND ')}
      ORDER BY p.description ASC
      LIMIT ${limit}`,
    params,
  )

  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    description: String(r.description),
    productType: toProductType(r.product_type),
    stockOnHand: toNum(r.stock_on_hand),
    averageCost: toNum(r.average_cost),
  }))
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
  productType?: ProductTypeId
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
  isArchived?: boolean

  /* ── Properties tab. Undefined means "leave as it is". ─────────────── */
  visibleInPos?: boolean
  changeDescription?: boolean
  askPriceAtSale?: boolean
  allowFractions?: boolean
  chargePctSubtotal?: boolean
  nonGpProduct?: boolean
  maxDiscountPct?: number
  variableType?: VariableTypeId
  priceCalc?: PriceCalcId

  packWeight?: number
  weightDescription?: string
  packSize?: number
  packDescription?: string
  lengthMm?: number
  widthMm?: number
  heightMm?: number
  prepTimeMinutes?: number

  scaleItem?: boolean
  labelScaleItem?: boolean
  fixedPriceScale?: boolean
  expiresInDays?: number

  /** Selling price INCLUSIVE of VAT, keyed by price_structure id. */
  prices?: Record<number, number>
  /**
   * Whether this product's cost / selling price fan out to the other stores in
   * this site's group. Undefined leaves the existing choice (or the group
   * default) alone.
   */
  sharesCost?: boolean
  sharesSelling?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateProduct(input: ProductInput): string | null {
  if (!input.code?.trim()) return 'A product code is required.'
  if (input.code.trim().length > 48) return 'Product code must be 48 characters or fewer.'
  if (!input.description?.trim()) return 'A description is required.'
  if (input.description.trim().length > 190) return 'Description must be 190 characters or fewer.'
  if ((input.lastCost ?? 0) < 0) return 'Cost cannot be negative.'
  if ((input.averageCost ?? 0) < 0) return 'Average cost cannot be negative.'
  /* Reorder levels are validated by saveLocationLevels, not here: they belong
     to a (product, location) pair rather than to the product. */
  for (const value of Object.values(input.prices ?? {})) {
    if (value < 0) return 'Selling prices cannot be negative.'
  }

  // Properties. A discount ceiling above 100% would let a cashier pay the
  // customer, and none of the sizes are meaningful as negatives.
  const pct = input.maxDiscountPct ?? 0
  if (pct < 0 || pct > 100) return 'Maximum discount must be between 0 and 100%.'
  if ((input.packWeight ?? 0) < 0) return 'Pack weight cannot be negative.'
  if ((input.packSize ?? 0) < 0) return 'Pack size cannot be negative.'
  if ((input.lengthMm ?? 0) < 0) return 'Length cannot be negative.'
  if ((input.widthMm ?? 0) < 0) return 'Width cannot be negative.'
  if ((input.heightMm ?? 0) < 0) return 'Height cannot be negative.'
  if ((input.prepTimeMinutes ?? 0) < 0) return 'Preparation time cannot be negative.'
  if ((input.expiresInDays ?? 0) < 0) return 'Expiry days cannot be negative.'

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

/**
 * The Properties tab columns, in one place.
 *
 * Create and update both write the identical set, so they share this rather
 * than repeating twenty columns twice — a field added to one list and forgotten
 * in the other would save on create and silently reset on the next edit.
 *
 * Returns the column names and their values in matching order. Booleans default
 * to false and numbers to zero, mirroring the schema defaults.
 */
const PROPERTY_COLUMNS = [
  'visible_in_pos',
  'change_description',
  'ask_price_at_sale',
  'allow_fractions',
  'charge_pct_subtotal',
  'non_gp_product',
  'max_discount_pct',
  'variable_type',
  'price_calc',
  'pack_weight',
  'weight_description',
  'pack_size',
  'pack_description',
  'length_mm',
  'width_mm',
  'height_mm',
  'prep_time_minutes',
  'scale_item',
  'label_scale_item',
  'fixed_price_scale',
  'expires_in_days',
] as const

/**
 * The same values keyed by column name, for the linked-store fan-out.
 *
 * Built from the identical helper so the properties written to another store
 * can never diverge from the ones written here.
 */
export function propertyColumnMap(input: ProductInput): Record<string, unknown> {
  const values = propertyValues(input)
  return Object.fromEntries(PROPERTY_COLUMNS.map((column, i) => [column, values[i]]))
}

function propertyValues(input: ProductInput): unknown[] {
  return [
    // A product on file is sold unless someone says otherwise, so an absent
    // flag means visible — matching the column default.
    input.visibleInPos === false ? 0 : 1,
    input.changeDescription ? 1 : 0,
    input.askPriceAtSale ? 1 : 0,
    input.allowFractions ? 1 : 0,
    input.chargePctSubtotal ? 1 : 0,
    input.nonGpProduct ? 1 : 0,
    (input.maxDiscountPct ?? 0).toFixed(3),
    toVariableType(input.variableType),
    toPriceCalc(input.priceCalc),
    (input.packWeight ?? 0).toFixed(4),
    input.weightDescription?.trim() || 'Kg',
    (input.packSize ?? 0).toFixed(3),
    input.packDescription?.trim() || 'None',
    (input.lengthMm ?? 0).toFixed(2),
    (input.widthMm ?? 0).toFixed(2),
    (input.heightMm ?? 0).toFixed(2),
    Math.trunc(input.prepTimeMinutes ?? 0),
    input.scaleItem ? 1 : 0,
    input.labelScaleItem ? 1 : 0,
    input.fixedPriceScale ? 1 : 0,
    Math.trunc(input.expiresInDays ?? 0),
  ]
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
          last_cost, average_cost, stock_on_hand,
          is_archived, ${PROPERTY_COLUMNS.join(', ')}, last_edit_date)
       VALUES (?,?,?,?, ?, ?,?,?,?,?, ?,?, ?,?,?, ?, ${PROPERTY_COLUMNS.map(() => '?').join(',')}, NOW())`,
      [
        code,
        input.barcode?.trim() || null,
        input.description.trim(),
        sanitiseHtml(input.extraDescription) || null,
        toProductType(input.productType),
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
        input.isArchived ? 1 : 0,
        ...propertyValues(input),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId
    await writePrices(tx, id, input.prices)

    /*
     * Opening stock has to LAND somewhere, and be explainable.
     *
     * Writing products.stock_on_hand alone breaks two invariants at once: the
     * quantity belongs to no location (C), and no movement accounts for it
     * (A). Both show up in the reconciliation as unexplained stock, which is
     * exactly what the reconciliation is for.
     *
     * The pile and the movement go in the SAME transaction as the product, so
     * a product can never exist holding stock that nothing accounts for.
     * Written directly rather than through recordMovement because the INSERT
     * above already put the quantity on the product — this records what it IS
     * rather than moving it again, the same reasoning seedOpeningStock uses.
     */
    const opening = input.openingStock ?? 0
    if (opening !== 0) {
      const [locRows] = await tx.execute(
        'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1',
      )
      const locationId = (locRows as RowDataPacket[])[0]?.id
      if (locationId) {
        await tx.execute(
          `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
                VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
          [id, locationId, opening.toFixed(3)] as never,
        )
        await tx.execute(
          `INSERT INTO stock_movements
             (product_id, location_id, movement_type, qty_change, qty_after,
              unit_cost_excl, source, user_name, note)
           VALUES (?, ?, 'opening', ?, ?, ?, 'opening', 'Product created', 'Opening stock at capture')`,
          [
            id,
            locationId,
            opening.toFixed(3),
            opening.toFixed(3),
            (input.averageCost ?? input.lastCost ?? 0).toFixed(4),
          ] as never,
        )
      }
    }

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
         product_type = ?, department_id = ?, brand_id = ?,
         image_path = ?, image_icon = ?, image_color = ?,
         purchase_vat_rate_id = ?, selling_vat_rate_id = ?,
         last_cost = ?,
         is_archived = ?,
         ${PROPERTY_COLUMNS.map((c) => `${c} = ?`).join(', ')},
         last_edit_date = NOW()
       WHERE id = ?`,
      [
        code,
        input.barcode?.trim() || null,
        input.description.trim(),
        sanitiseHtml(input.extraDescription) || null,
        toProductType(input.productType),
        input.departmentId ?? null,
        input.brandId ?? null,
        input.imagePath ?? null,
        input.imageIcon ?? null,
        input.imageColor ?? null,
        input.purchaseVatRateId ?? null,
        input.sellingVatRateId ?? null,
        (input.lastCost ?? 0).toFixed(4),
        input.isArchived ? 1 : 0,
        ...propertyValues(input),
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

export type DeleteProductResult =
  | { ok: true; archived: false }
  | { ok: true; archived: true; reason: string }
  | { ok: false; error: string }

/**
 * Deletes a product — or archives it, once anything references it.
 *
 * This function used to just DELETE, with a comment saying it should refuse
 * once sales history existed. That history now exists, so it does.
 *
 * A sold product cannot be deleted: `sales_document_lines.product_id` is ON
 * DELETE SET NULL and `stock_movements.product_id` is RESTRICT, so deleting one
 * would either strip the link off historical invoices or fail on a constraint
 * nobody can read. Archiving keeps every document and every movement intact and
 * takes the product off the till, which is what "delete" actually means to
 * whoever clicked it.
 *
 * Returns which of the two happened, so the screen can say so rather than
 * silently doing something other than what was asked.
 */
export async function deleteProduct(siteId: number, id: number): Promise<DeleteProductResult> {
  const counts = await siteQueryOne<RowDataPacket & { lines: number; movements: number }>(
    siteId,
    `SELECT (SELECT COUNT(*) FROM sales_document_lines WHERE product_id = ?) AS lines,
            (SELECT COUNT(*) FROM stock_movements      WHERE product_id = ?) AS movements`,
    [id, id],
  )

  const lines = Number(counts?.lines ?? 0)
  const movements = Number(counts?.movements ?? 0)

  if (lines > 0 || movements > 0) {
    await siteExecute(siteId, 'UPDATE products SET is_archived = 1 WHERE id = ?', [id])

    const parts: string[] = []
    if (lines > 0) parts.push(`${lines} sale line${lines === 1 ? '' : 's'}`)
    if (movements > 0) parts.push(`${movements} stock movement${movements === 1 ? '' : 's'}`)

    return {
      ok: true,
      archived: true,
      reason: `It has ${parts.join(' and ')}, so it was archived instead of deleted — that history has to stay readable.`,
    }
  }

  // Never sold, never moved: safe to remove outright. product_prices cascades.
  await siteExecute(siteId, 'DELETE FROM products WHERE id = ?', [id])
  return { ok: true, archived: false }
}

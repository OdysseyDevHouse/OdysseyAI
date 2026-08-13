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
import { writePriceRows } from './reprice'
import { resolveMasterCode } from './masterCodes'

export type Product = {
  id: number
  code: string
  barcode: string | null
  description: string
  extraDescription: string | null
  productType: ProductTypeId
  /**
   * Made in batches, rather than exploded at the till.
   *
   * Only meaningful on a recipe product. False — the default — is the original
   * behaviour: selling one deducts its ingredients and it carries no stock of
   * its own. True means a manufacturing order builds it ahead of time and it
   * has a real pile. See src/lib/site/manufacturing.ts.
   */
  isManufactured: boolean

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

  /**
   * When the row was first written. Never changes.
   *
   * Distinct from lastEditDate, which is when a PERSON last saved the product —
   * "added this month" and "touched this month" are different questions, and
   * the product list offers a sort for each.
   */
  createdAt: Date | null
  lastEditDate: Date | null
  lastPurchaseDate: Date | null
  lastSoldDate: Date | null
  lastAdjustDate: Date | null
  /**
   * When this product was last physically counted on a stock take.
   *
   * Separate from lastAdjustDate, which a posted take also stamps: one says
   * somebody corrected the figure, the other says somebody walked the shelf.
   * See 109_list_columns.sql.
   */
  lastStockTakeDate: Date | null
  /**
   * Reorder levels for the MAIN location — see PRODUCT_LEVELS_JOIN.
   *
   * Not the site total, and not this-or-any-location: levels are per location
   * and a list row shows the main one. Zero when the product has no row there.
   */
  minStock: number
  maxStock: number

  /* ── Where this row sits in the variant scheme ─────────────────────── */
  /**
   * True when this product is a variant PARENT — a grouping row.
   *
   * A parent never sells and never holds stock; the columns a list shows for it
   * are about its children, not itself. See productVariants.ts for the rules.
   */
  hasVariants: boolean
  /** Set when this product is somebody's variant. Null on an ordinary product. */
  parentId: number | null
  /**
   * How many live variants sit under this parent. Zero on everything else.
   *
   * Counted in SQL alongside the row rather than fetched per parent, because a
   * page of 50 products would otherwise be 50 extra round trips.
   */
  variantCount: number

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
 *
 * ── A PARENT IS LOW WHEN ANY OF ITS VARIANTS IS ──────────────────────────
 *
 * A parent holds no stock of its own and therefore has no product_location_stock
 * rows at all, so the first branch is always false for one. Left at that, a
 * group down to two Larges would never flag, and the "below minimum" slice —
 * which is the screen someone opens to decide what to reorder — would silently
 * omit every variant product in the catalogue. The pile is the children's, so
 * the question has to be asked of the children.
 */
const BELOW_MINIMUM_SQL = `(EXISTS (
  SELECT 1 FROM product_location_stock pls
   WHERE pls.product_id = p.id
     AND pls.min_stock > 0
     AND pls.stock_on_hand <= pls.min_stock
) OR (p.has_variants = 1 AND EXISTS (
  SELECT 1 FROM products child
    JOIN product_location_stock cpls ON cpls.product_id = child.id
   WHERE child.parent_id = p.id
     AND child.is_archived = 0
     AND cpls.min_stock > 0
     AND cpls.stock_on_hand <= cpls.min_stock
)))`

/**
 * How many live variants a parent has.
 *
 * Archived children are excluded: a group whose mediums were discontinued
 * should read "4 variants", not 5, or the badge disagrees with the list the
 * click-through then shows.
 */
const VARIANT_COUNT_SQL = `(
  SELECT COUNT(*) FROM products child
   WHERE child.parent_id = p.id AND child.is_archived = 0
)`

/**
 * A parent's stock is the sum of its children's.
 *
 * The column on the row itself is always 0 — rule 4, enforced by
 * recordMovement. Showing that zero in a list would say "out of stock" about a
 * shirt with 300 on the shelf, which is worse than showing nothing. So the
 * group's row reports the group's pile.
 *
 * Zero for every other product, where p.stock_on_hand is already the answer.
 */
const VARIANT_STOCK_SQL = `(
  SELECT COALESCE(SUM(child.stock_on_hand), 0) FROM products child
   WHERE child.parent_id = p.id AND child.is_archived = 0
)`

/*
 * Reorder levels, from the MAIN location only.
 *
 * Levels are per location by design (025/028): a warehouse holding 500 and a
 * shop floor holding 5 need different reorder points, and products.min_stock
 * was dropped precisely so one number could not pretend to govern both.
 *
 * A list row is one line per product, so it cannot show a level per location —
 * it has to pick one, and main is the one a person means when they ask without
 * qualifying. This is the same join the report builder already uses to answer
 * the same question (reportBuilder/catalog.ts), so the two agree rather than
 * offering a store two different "minimum level" figures.
 *
 * A store that needs another location's levels reads them on the product's own
 * Inventory tab, which shows every location at once.
 */
const PRODUCT_LEVELS_JOIN = `
    LEFT JOIN product_location_stock pl
           ON pl.product_id = p.id
          AND pl.location_id = (
                SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1
              )
`

const SELECT_PRODUCT = `
  SELECT p.id, p.code, p.barcode, p.description, p.extra_description, p.product_type,
         p.is_manufactured,
         p.has_variants, p.parent_id,
         ${VARIANT_COUNT_SQL} AS variant_count,
         ${VARIANT_STOCK_SQL} AS variant_stock,
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
         p.created_at,
         p.last_edit_date, p.last_purchase_date, p.last_sold_date, p.last_adjust_date,
         p.last_stock_take_date,
         pl.min_stock AS min_stock, pl.max_stock AS max_stock,
         pv.rate AS purchase_vat_rate, sv.rate AS selling_vat_rate
    FROM products p
    LEFT JOIN vat_rates pv ON pv.id = p.purchase_vat_rate_id
    LEFT JOIN vat_rates sv ON sv.id = p.selling_vat_rate_id
    ${PRODUCT_LEVELS_JOIN}
`

function mapProduct(
  r: ProductRow,
  basis: CostBasis,
  prices: { structureId: number; name: string; position: number; isDefault: boolean; incl: number }[],
): Product {
  const purchaseVat = toNum(r.purchase_vat_rate)
  const sellingVat = toNum(r.selling_vat_rate)
  const cost = costLine(r.average_cost, r.last_cost, purchaseVat, basis)
  const isParent = Number(r.has_variants ?? 0) === 1

  return {
    id: Number(r.id),
    code: String(r.code),
    barcode: (r.barcode as string | null) ?? null,
    description: String(r.description),
    extraDescription: (r.extra_description as string | null) ?? null,
    productType: toProductType(r.product_type),
    isManufactured: Number(r.is_manufactured ?? 0) === 1,

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

    // A parent's own column is always zero; the group's pile is what the row
    // is standing for. See VARIANT_STOCK_SQL.
    stockOnHand: isParent ? toNum(r.variant_stock) : toNum(r.stock_on_hand),
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

    createdAt: (r.created_at as Date | null) ?? null,
    lastEditDate: (r.last_edit_date as Date | null) ?? null,
    lastPurchaseDate: (r.last_purchase_date as Date | null) ?? null,
    lastSoldDate: (r.last_sold_date as Date | null) ?? null,
    lastAdjustDate: (r.last_adjust_date as Date | null) ?? null,
    lastStockTakeDate: (r.last_stock_take_date as Date | null) ?? null,
    minStock: toNum(r.min_stock),
    maxStock: toNum(r.max_stock),

    hasVariants: isParent,
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    variantCount: Number(r.variant_count ?? 0),

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

/**
 * What the catalogue can be ordered by.
 *
 * 'description' and 'code' are the two ways a person names a product; 'created'
 * and 'edited' are the two ways they ask "what changed". Kept as a closed union
 * because the value reaches an ORDER BY — see SORT_COLUMNS.
 */
export type ProductSort = 'description' | 'code' | 'created' | 'edited'

export type ProductListOptions = {
  search?: string
  departmentIds?: number[]
  brandId?: number
  /**
   * Only products of these kinds — the type filter on the list screen.
   *
   * An array rather than a single id so the screen can later offer more than
   * one at a time without another signature change.
   */
  productTypes?: readonly ProductTypeId[]
  includeArchived?: boolean
  belowMinimum?: boolean
  /**
   * List only the variants of this parent, instead of the catalogue.
   *
   * The click-through from a collapsed group. Set, the other filters still
   * apply — a group opened from the "below minimum" slice shows the variants
   * that are actually low, which is the question that was being asked.
   */
  parentId?: number
  /**
   * Fold variants away under their parent. Default TRUE.
   *
   * A shirt in 5 sizes × 4 colours is 21 rows of catalogue for one thing on a
   * shelf, and the 20 children look unrelated to each other in a list sorted by
   * description. The parent stands for the group and carries a count; opening
   * it lists the children.
   *
   * ── SEARCH DELIBERATELY OVERRIDES THIS ────────────────────────────────
   *
   * A search is a question about a specific product, and the answer is often a
   * child: someone scans the barcode on a Large Blue shirt, or types its code
   * off a purchase order. Hiding it because its parent exists would make the
   * catalogue look like it had lost the product. So `search` un-collapses, and
   * the children carry their parent's name on screen for context.
   */
  collapseVariants?: boolean
  /** Defaults to 'description' — the order the catalogue has always been in. */
  sort?: ProductSort
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * The sort keys, mapped to SQL. Interpolated into the ORDER BY, so this lookup
 * is what keeps a URL parameter out of the query — nothing else may reach it.
 *
 * `created` and `edited` COALESCE to a floor rather than sorting NULLs wherever
 * MySQL puts them: last_edit_date is null on a product nobody has re-saved, and
 * "never edited" belongs at the old end of the list, not silently first.
 */
const SORT_COLUMNS: Record<ProductSort, string> = {
  description: 'p.description',
  code: 'p.code',
  created: 'p.created_at',
  edited: "COALESCE(p.last_edit_date, '1000-01-01')",
}

export async function listProducts(
  siteId: number,
  opts: ProductListOptions = {},
): Promise<{ items: Product[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (!opts.includeArchived) where.push('p.is_archived = 0')

  const searching = !!opts.search?.trim()

  if (searching) {
    const term = `%${opts.search!.trim()}%`
    // Barcode matches exactly: a scanner sends the whole code, and a LIKE would
    // turn every scan into a full table scan.
    where.push('(p.description LIKE ? OR p.code LIKE ? OR p.barcode = ?)')
    params.push(term, term, opts.search!.trim())
  }

  if (opts.parentId) {
    // Opening one group. Only its children, and never the parent itself — the
    // parent is the heading above this list, not a row inside it.
    where.push('p.parent_id = ?')
    params.push(opts.parentId)
  } else if ((opts.collapseVariants ?? true) && !searching) {
    // A child is represented by its parent's row. See collapseVariants.
    where.push('p.parent_id IS NULL')
  }
  if (opts.departmentIds?.length) {
    where.push(`p.department_id IN (${opts.departmentIds.map(() => '?').join(',')})`)
    params.push(...opts.departmentIds)
  }
  if (opts.brandId) {
    where.push('p.brand_id = ?')
    params.push(opts.brandId)
  }
  /* A variant PARENT stands for its children, so it is matched on THEIRS.
     Testing the parent's own product_type would drop a whole group of serial
     products because the grouping row itself was left as 'normal'; keeping
     every parent regardless would put all forty groups under a "Service"
     filter. So a group survives when any live child matches — which is exactly
     what the row on screen is claiming. */
  if (opts.productTypes?.length) {
    const list = opts.productTypes.map(() => '?').join(',')
    where.push(`(
      CASE WHEN p.has_variants = 1
           THEN EXISTS (SELECT 1 FROM products child
                         WHERE child.parent_id = p.id
                           AND child.is_archived = 0
                           AND child.product_type IN (${list}))
           ELSE p.product_type IN (${list})
      END
    )`)
    params.push(...opts.productTypes, ...opts.productTypes)
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

  /*
   * Inside a group, the picker's own order — sizes are not alphabetical.
   *
   * Small/Medium/Large sorted by description reads Large, Medium, Small, which
   * is exactly the ordering variant_sort exists to override. That order is the
   * group's own and is NOT overridable by the sort argument: the list of sizes
   * under one shirt has a right order, and it is not A to Z.
   *
   * Everywhere else the caller chooses, defaulting to description ascending —
   * what the catalogue has always been. `p.id` breaks ties so that paging is
   * stable: without it two products created in the same second can swap places
   * between page 1 and page 2, and one of them is then never seen.
   */
  const column = SORT_COLUMNS[opts.sort ?? 'description']
  const direction = opts.direction === 'desc' ? 'DESC' : 'ASC'
  const orderSql = opts.parentId
    ? 'ORDER BY p.variant_sort, p.axis_1_value, p.axis_2_value, p.id'
    : `ORDER BY ${column} ${direction}, p.id ASC`

  const [rows, countRow, basis] = await Promise.all([
    siteQuery<ProductRow>(
      siteId,
      `${SELECT_PRODUCT} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`,
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
  /**
   * The default-structure selling price, VAT inclusive.
   *
   * Carried so a picker can show what a product costs TODAY. The specials form
   * needs it: a marked-down price means nothing without the figure it is
   * marked down from, and the discount-percentage box is worked out against it.
   */
  sellingIncl: number
  departmentId: number | null
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
 *
 * ── PARENTS ARE NEVER OFFERED ──────────────────────────────────────────────
 *
 * A variant parent is a catalogue idea, not a transactional one: it holds no
 * stock and recordMovement refuses it outright. Listing one here would let
 * someone put "Shirt" on a recipe, a special or a purchase order and only find
 * out at posting time, with the line already typed. The variants themselves are
 * ordinary products and appear normally.
 */
export async function searchProductsForPicker(
  siteId: number,
  opts: { search?: string; exclude?: number; limit?: number } = {},
): Promise<ProductPick[]> {
  const where: string[] = ['p.is_archived = 0', 'p.has_variants = 0']
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
    `SELECT p.id, p.code, p.description, p.product_type, p.stock_on_hand,
            p.average_cost, p.department_id,
            -- The DEFAULT structure's price. A picker shows one number, so it
            -- shows the shelf price rather than making the caller choose.
            (SELECT pp.selling_price_incl FROM product_prices pp
              JOIN price_structures ps ON ps.id = pp.price_structure_id
             WHERE pp.product_id = p.id
             ORDER BY ps.is_default DESC, ps.id LIMIT 1) AS selling_incl
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
    sellingIncl: toNum(r.selling_incl),
    departmentId: r.department_id === null ? null : Number(r.department_id),
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
  /** Only meaningful on a recipe product — see Product.isManufactured. */
  isManufactured?: boolean
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
export async function resolveVat(
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
  audit?: { source: 'editor' | 'import'; userName: string },
) {
  const rows = Object.entries(prices ?? {}).map(([structureId, incl]) => ({
    productId,
    priceStructureId: Number(structureId),
    priceIncl: incl,
  }))
  if (rows.length === 0) return
  // Through the ONE definition of a price write (reprice.ts), which is what
  // puts editor and import saves on the history (144) beside every other path.
  await writePriceRows(tx, rows, {
    source: audit?.source ?? 'editor',
    userName: audit?.userName ?? '',
  })
}

export async function createProduct(
  siteId: number,
  input: ProductInput,
  /** Who is writing the prices, for the history (144). Editor by default. */
  audit?: { source: 'editor' | 'import'; userName: string },
): Promise<SaveResult> {
  // BEFORE validate, which rejects a blank code — see masterCodes.ts.
  const code = await resolveMasterCode(siteId, 'product', input.code)

  const invalid = validateProduct({ ...input, code })
  if (invalid) return { ok: false, error: invalid }

  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM products WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Product code "${code}" is already in use.` }

  const vat = await resolveVat(siteId, input)

  return siteTransaction(siteId, async (tx) => {
    const id = await insertProductTx(tx, { ...input, code }, vat, audit)
    return { ok: true as const, id }
  })
}

/**
 * The INSERT half of createProduct, in a transaction the caller already owns.
 *
 * Split out for the refer wizard, which creates a whole pack range — single,
 * six-pack, case — and must not leave half a range behind if the third one
 * fails. createProduct opens its own transaction, so N of them cannot be made
 * atomic by nesting; this can.
 *
 * The caller owns everything createProduct does around this: resolving the
 * code, validating, checking for a clash, and resolving the VAT rates. Those
 * all read rather than write, so they belong outside the transaction and the
 * wizard does them for every row before opening one.
 */
export async function insertProductTx(
  tx: PoolConnection,
  input: ProductInput & { code: string },
  vat: { purchase: number | null; selling: number | null },
  /** Who is writing the prices, for the history (144). */
  audit?: { source: 'editor' | 'import'; userName: string },
): Promise<number> {
  {
    const [res] = await tx.execute(
      `INSERT INTO products
         (code, barcode, description, extra_description, product_type, is_manufactured,
          department_id, brand_id, image_path, image_icon, image_color,
          purchase_vat_rate_id, selling_vat_rate_id,
          last_cost, average_cost, stock_on_hand,
          is_archived, ${PROPERTY_COLUMNS.join(', ')}, last_edit_date)
       VALUES (?,?,?,?, ?,?, ?,?,?,?,?, ?,?, ?,?,?, ?, ${PROPERTY_COLUMNS.map(() => '?').join(',')}, NOW())`,
      [
        input.code,
        input.barcode?.trim() || null,
        input.description.trim(),
        sanitiseHtml(input.extraDescription) || null,
        toProductType(input.productType),
        // Only a recipe carries this. Storing it on any other type would leave
        // a flag that means nothing and reads as though it might.
        toProductType(input.productType) === 'recipe' && input.isManufactured ? 1 : 0,
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
    await writePrices(tx, id, input.prices, audit)

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

    return id
  }
}

export async function updateProduct(
  siteId: number,
  id: number,
  input: ProductInput,
  /** Who is writing the prices, for the history (144). Editor by default. */
  audit?: { source: 'editor' | 'import'; userName: string },
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

  /*
   * "Made in batches" cannot be changed once the product has history.
   *
   * The flag decides what a SALE of this product moves — the finished item, or
   * its ingredients. Flipping it does not restate the movements already
   * written, so a product that sold ten burgers as ingredient deductions and
   * then becomes manufactured has ten sales that mean one thing and a pile that
   * assumes another. Nothing can reconcile that afterwards.
   *
   * Checked here rather than only in the form, because a server action is a
   * public endpoint and a disabled checkbox is not a boundary.
   */
  const wanted = toProductType(input.productType) === 'recipe' && input.isManufactured ? 1 : 0
  const existing = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT p.is_manufactured, p.stock_on_hand,
            (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = p.id) AS movements
       FROM products p WHERE p.id = ?`,
    [id],
  )
  if (existing && Number(existing.is_manufactured ?? 0) !== wanted) {
    const hasHistory = Number(existing.movements ?? 0) > 0 || toNum(existing.stock_on_hand) !== 0
    if (hasHistory) {
      return {
        ok: false,
        error:
          'This product already has stock or movement history, so whether it is made in batches can no longer be changed. ' +
          'Doing so would change what its past sales meant. Create a new product instead.',
      }
    }
  }

  return siteTransaction(siteId, async (tx) => {
    /*
     * image_path and image_icon are written ONLY when the caller names them.
     *
     * Both are owned by other screens — the photographs panel mirrors the
     * primary picture into image_path, and the till-icon picker writes
     * image_icon — and neither is a field on the product form. Listing them
     * unconditionally meant every ordinary save sent `undefined ?? null` and
     * wiped whichever one those screens had just set: upload a photo, save the
     * product, and the till button went blank.
     *
     * `undefined` means "leave as it is" here, exactly as it already does for
     * the Properties tab; an explicit null still clears the column, which is
     * how the icon is removed.
     */
    const imageAssignments: string[] = []
    const imageValues: (string | null)[] = []
    if (input.imagePath !== undefined) {
      imageAssignments.push('image_path = ?')
      imageValues.push(input.imagePath)
    }
    if (input.imageIcon !== undefined) {
      imageAssignments.push('image_icon = ?')
      imageValues.push(input.imageIcon)
    }

    const [res] = await tx.execute(
      `UPDATE products SET
         code = ?, barcode = ?, description = ?, extra_description = ?,
         product_type = ?, is_manufactured = ?, department_id = ?, brand_id = ?,
         ${imageAssignments.length ? `${imageAssignments.join(', ')},` : ''}
         image_color = ?,
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
        wanted,
        input.departmentId ?? null,
        input.brandId ?? null,
        ...imageValues,
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

    await writePrices(tx, id, input.prices, audit)
    return { ok: true as const, id }
  }).catch((err) => ({ ok: false as const, error: (err as Error).message }))
}

/**
 * Writes a composed product's cost, worked out from what it is made of.
 *
 * Its own right rather than part of updateProduct, which deliberately refuses
 * to write average_cost at all: for a purchased product that figure is a
 * consequence of the purchases, and letting a form overwrite it would falsify
 * stock valuation.
 *
 * A recipe product is the one case where that reasoning inverts. Nothing was
 * ever bought called "burger", so there are no purchases for an average to be a
 * consequence OF — its stored cost is 0 forever, and every report that reads it
 * shows a 100% margin. The sum of the ingredients is the only true cost it has,
 * so BOTH columns are set to it: last_cost so the form and price list agree,
 * average_cost so a site priced on the average basis reads the same number.
 *
 * Callers pass a figure from compositionCost(), which is what the till charges
 * a sale at. Do not call this with anything a browser supplied.
 */
export async function setDerivedCost(
  siteId: number,
  id: number,
  costExcl: number,
): Promise<void> {
  await siteExecute(
    siteId,
    'UPDATE products SET last_cost = ?, average_cost = ? WHERE id = ?',
    [costExcl.toFixed(4), costExcl.toFixed(4), id],
  )
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
  // NOT aliased `lines`: LINES is a reserved word in MariaDB (LOAD DATA ...
  // LINES TERMINATED BY), so an unquoted alias is a syntax error and delete
  // fails on every product.
  const counts = await siteQueryOne<RowDataPacket & { sale_lines: number; movements: number }>(
    siteId,
    `SELECT (SELECT COUNT(*) FROM sales_document_lines WHERE product_id = ?) AS sale_lines,
            (SELECT COUNT(*) FROM stock_movements      WHERE product_id = ?) AS movements`,
    [id, id],
  )

  const lines = Number(counts?.sale_lines ?? 0)
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

/* ── Bulk operations ─────────────────────────────────────────────────────── */

/**
 * What a bulk action did, and what it refused to do.
 *
 * Mirrors customers' BulkResult deliberately — same shape, same reasoning:
 * "38 updated, 2 skipped" with no list of which two, and why, is worse than
 * not offering the action at all.
 */
export type ProductBulkResult = {
  updated: number
  skipped: { id: number; code: string; name: string; reason: string }[]
}

/**
 * Every bulk change the product list offers.
 *
 * One member per action in the bulk options dialog, and the `kind` doubles as
 * that dialog's option key — so an action can never be offered on screen
 * without a change behind it to apply.
 */
export type ProductBulkChange =
  /* ── The product itself ── */
  | { kind: 'department'; departmentId: number | null }
  | { kind: 'brand'; brandId: number | null }
  | { kind: 'instructionGroup'; groupId: number; mode: 'add' | 'remove' }
  | { kind: 'color'; imageColor: string | null }
  | { kind: 'sellingVat'; vatRateId: number | null }
  | { kind: 'purchaseVat'; vatRateId: number | null }
  /* ── Properties ── */
  | { kind: 'visibleInPos'; value: boolean }
  | { kind: 'showOnline'; value: boolean }
  | { kind: 'changeDescription'; value: boolean }
  | { kind: 'askPriceAtSale'; value: boolean }
  | { kind: 'allowFractions'; value: boolean }
  | { kind: 'scaleItem'; value: boolean }
  | { kind: 'labelScaleItem'; value: boolean }
  | { kind: 'maxDiscountPct'; value: number }
  | { kind: 'expiresInDays'; value: number }
  | { kind: 'packSize'; value: number }
  | { kind: 'packDescription'; value: string }
  | { kind: 'packWeight'; value: number }
  | { kind: 'weightDescription'; value: string }
  | { kind: 'priceCalc'; value: PriceCalcId }
  /* ── Reorder levels: per LOCATION, never site-wide (see migration 028). ── */
  | { kind: 'minLevel'; locationId: number; value: number }
  | { kind: 'maxLevel'; locationId: number; value: number }
  /* ── Lifecycle ── */
  | { kind: 'archive'; archived: boolean }
  | { kind: 'delete' }

/** The row bulk needs to decide and report — far cheaper than SELECT_PRODUCT. */
type BulkRow = RowDataPacket & {
  id: number
  code: string
  description: string
  is_archived: number
  variant_count: number
}

/**
 * Applies one change to many products.
 *
 * Same contract as bulkUpdateCustomers: validate the change ONCE, load the
 * rows, partition them into permitted and refused, then write the permitted
 * set in a single statement inside a transaction. A blind
 * `UPDATE ... WHERE id IN (...)` would happily set a scale flag on a variant
 * parent that holds no stock, and per-row updates would leave a half-applied
 * change behind on the first failure.
 */
export async function bulkUpdateProducts(
  siteId: number,
  ids: readonly number[],
  change: ProductBulkChange,
): Promise<ProductBulkResult> {
  const unique = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0)
  if (unique.length === 0) return { updated: 0, skipped: [] }

  const invalid = validateProductBulk(change)
  if (invalid) {
    return {
      updated: 0,
      skipped: unique.map((id) => ({ id, code: '', name: '', reason: invalid })),
    }
  }

  const placeholders = unique.map(() => '?').join(',')
  const rows = await siteQuery<BulkRow>(
    siteId,
    `SELECT p.id, p.code, p.description, p.is_archived,
            ${VARIANT_COUNT_SQL} AS variant_count
       FROM products p
      WHERE p.id IN (${placeholders})`,
    unique,
  )

  const permitted: BulkRow[] = []
  const skipped: ProductBulkResult['skipped'] = []

  for (const row of rows) {
    const refusal = refuseProductBulk(row, change)
    if (refusal) {
      skipped.push({ id: Number(row.id), code: row.code, name: row.description, reason: refusal })
    } else {
      permitted.push(row)
    }
  }

  // An id that matched no row was deleted between the list render and the
  // action — report it rather than silently counting it as done.
  for (const id of unique) {
    if (!rows.some((r) => Number(r.id) === id)) {
      skipped.push({ id, code: '', name: '', reason: 'No longer exists.' })
    }
  }

  if (permitted.length === 0) return { updated: 0, skipped }

  const idList = permitted.map((r) => Number(r.id))

  // Three kinds do not write a products column, so they never reach the SET
  // clause: delete has its own archive-instead rule, instruction groups are a
  // join table, and reorder levels live on product_location_stock.
  if (change.kind === 'delete') return bulkDeleteProducts(siteId, permitted, skipped)
  if (change.kind === 'instructionGroup') {
    return bulkInstructionGroup(siteId, idList, change, skipped)
  }
  if (change.kind === 'minLevel' || change.kind === 'maxLevel') {
    return bulkStockLevel(siteId, idList, change, skipped)
  }

  const { sql, params } = productBulkSetClause(change)
  const idPlaceholders = idList.map(() => '?').join(',')

  await siteTransaction(siteId, async (tx) => {
    // last_edit_date moves because a PERSON made this change — that is exactly
    // what distinguishes it from updated_at, which a stock movement also touches.
    await tx.execute(
      `UPDATE products SET ${sql}, last_edit_date = NOW() WHERE id IN (${idPlaceholders})`,
      [...params, ...idList] as never,
    )
  })

  return { updated: idList.length, skipped }
}

/** Why this product cannot take this change. Null means it can. */
function refuseProductBulk(row: BulkRow, change: ProductBulkChange): string | null {
  const isParent = Number(row.variant_count) > 0

  if (isParent) {
    // A variant parent is a catalogue heading: it holds no stock and is never
    // sold directly, so a per-unit setting on it would be quietly meaningless.
    const perUnit: ProductBulkChange['kind'][] = [
      'scaleItem',
      'labelScaleItem',
      'minLevel',
      'maxLevel',
      'packSize',
      'packWeight',
    ]
    if (perUnit.includes(change.kind)) return 'It is a variant parent and holds no stock.'
    if (change.kind === 'delete') return 'It has variants — delete those first.'
  }

  if (change.kind === 'archive' && change.archived && Number(row.is_archived) === 1) {
    return 'Already archived.'
  }

  return null
}

/** Whether the change itself makes sense, before any row is loaded. */
function validateProductBulk(change: ProductBulkChange): string | null {
  switch (change.kind) {
    case 'maxDiscountPct':
      if (change.value < 0 || change.value > 100) return 'Max discount must be between 0 and 100%.'
      return null
    case 'expiresInDays':
      if (change.value < 0 || change.value > 3650) return 'Expiry must be between 0 and 3650 days.'
      return null
    case 'minLevel':
    case 'maxLevel':
      if (!Number.isFinite(change.locationId) || change.locationId <= 0) {
        return 'Choose a stock location.'
      }
      if (change.value < 0) return 'A reorder level cannot be negative.'
      return null
    case 'packSize':
    case 'packWeight':
      if (change.value < 0) return 'This cannot be negative.'
      return null
    case 'packDescription':
    case 'weightDescription':
      if (change.value.trim().length > 24) return 'Description must be 24 characters or fewer.'
      return null
    case 'instructionGroup':
      if (!Number.isFinite(change.groupId) || change.groupId <= 0) {
        return 'Choose an instruction group.'
      }
      return null
    default:
      return null
  }
}

function productBulkSetClause(change: ProductBulkChange): { sql: string; params: unknown[] } {
  switch (change.kind) {
    case 'department':
      return { sql: 'department_id = ?', params: [change.departmentId] }
    case 'brand':
      return { sql: 'brand_id = ?', params: [change.brandId] }
    case 'color':
      return { sql: 'image_color = ?', params: [change.imageColor] }
    case 'sellingVat':
      return { sql: 'selling_vat_rate_id = ?', params: [change.vatRateId] }
    case 'purchaseVat':
      return { sql: 'purchase_vat_rate_id = ?', params: [change.vatRateId] }
    case 'visibleInPos':
      return { sql: 'visible_in_pos = ?', params: [change.value ? 1 : 0] }
    case 'showOnline':
      return { sql: 'show_online = ?', params: [change.value ? 1 : 0] }
    case 'changeDescription':
      return { sql: 'change_description = ?', params: [change.value ? 1 : 0] }
    case 'askPriceAtSale':
      return { sql: 'ask_price_at_sale = ?', params: [change.value ? 1 : 0] }
    case 'allowFractions':
      return { sql: 'allow_fractions = ?', params: [change.value ? 1 : 0] }
    case 'scaleItem':
      return { sql: 'scale_item = ?', params: [change.value ? 1 : 0] }
    case 'labelScaleItem':
      return { sql: 'label_scale_item = ?', params: [change.value ? 1 : 0] }
    case 'maxDiscountPct':
      return { sql: 'max_discount_pct = ?', params: [change.value.toFixed(3)] }
    case 'expiresInDays':
      return { sql: 'expires_in_days = ?', params: [Math.trunc(change.value)] }
    case 'packSize':
      return { sql: 'pack_size = ?', params: [change.value.toFixed(3)] }
    case 'packDescription':
      return { sql: 'pack_description = ?', params: [change.value.trim() || 'None'] }
    case 'packWeight':
      return { sql: 'pack_weight = ?', params: [change.value.toFixed(4)] }
    case 'weightDescription':
      return { sql: 'weight_description = ?', params: [change.value.trim() || 'Kg'] }
    case 'priceCalc':
      return { sql: 'price_calc = ?', params: [toPriceCalc(change.value)] }
    case 'archive':
      return { sql: 'is_archived = ?', params: [change.archived ? 1 : 0] }
    default:
      // Unreachable: delete, instruction groups and reorder levels are handled
      // before this point. Throwing keeps the switch honest if one is added.
      throw new Error(`No SET clause for bulk change: ${(change as ProductBulkChange).kind}`)
  }
}

/**
 * Adds or removes one instruction group across the selection.
 *
 * A join table, so this is INSERT IGNORE / DELETE rather than an UPDATE.
 * Adding appends after each product's existing groups rather than renumbering,
 * because a bulk change must not reshuffle an order someone set per product.
 */
async function bulkInstructionGroup(
  siteId: number,
  ids: number[],
  change: Extract<ProductBulkChange, { kind: 'instructionGroup' }>,
  skipped: ProductBulkResult['skipped'],
): Promise<ProductBulkResult> {
  const placeholders = ids.map(() => '?').join(',')

  await siteTransaction(siteId, async (tx) => {
    if (change.mode === 'remove') {
      await tx.execute(
        `DELETE FROM product_instruction_groups
          WHERE group_id = ? AND product_id IN (${placeholders})`,
        [change.groupId, ...ids] as never,
      )
      return
    }

    // INSERT IGNORE so re-adding a group a product already has is a no-op
    // rather than a duplicate-key error that fails the whole batch.
    await tx.execute(
      `INSERT IGNORE INTO product_instruction_groups (product_id, group_id, sort_order)
       SELECT p.id, ?, COALESCE(
                (SELECT MAX(x.sort_order) + 1
                   FROM product_instruction_groups x
                  WHERE x.product_id = p.id), 0)
         FROM products p
        WHERE p.id IN (${placeholders})`,
      [change.groupId, ...ids] as never,
    )
  })

  return { updated: ids.length, skipped }
}

/**
 * Sets one reorder level, for one location, across the selection.
 *
 * Levels live on product_location_stock rather than products — see
 * 028_drop_product_levels.sql, which dropped the site-wide columns because a
 * warehouse and a shop floor need different reorder points. A product with no
 * row for that location gets one, so setting a level on a newly added room
 * works instead of silently updating nothing.
 */
async function bulkStockLevel(
  siteId: number,
  ids: number[],
  change: Extract<ProductBulkChange, { kind: 'minLevel' | 'maxLevel' }>,
  skipped: ProductBulkResult['skipped'],
): Promise<ProductBulkResult> {
  const column = change.kind === 'minLevel' ? 'min_stock' : 'max_stock'
  const value = change.value.toFixed(3)

  await siteTransaction(siteId, async (tx) => {
    // Row by row because each INSERT targets a different product/location pair
    // and the selection is a page of 50, not a catalogue-wide sweep.
    for (const id of ids) {
      await tx.execute(
        `INSERT INTO product_location_stock (product_id, location_id, ${column})
              VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`,
        [id, change.locationId, value] as never,
      )
    }
  })

  return { updated: ids.length, skipped }
}

/**
 * Deletes the selection, archiving anything that has history.
 *
 * Reuses deleteProduct rather than restating its rule: a product that has been
 * sold or moved keeps its documents readable and comes off the till instead.
 * Each of those is reported as skipped with that reason, so the count never
 * claims a delete that was really an archive.
 */
async function bulkDeleteProducts(
  siteId: number,
  rows: BulkRow[],
  skipped: ProductBulkResult['skipped'],
): Promise<ProductBulkResult> {
  let deleted = 0

  for (const row of rows) {
    const result = await deleteProduct(siteId, Number(row.id))
    if (result.ok && result.archived) {
      skipped.push({
        id: Number(row.id),
        code: row.code,
        name: row.description,
        reason: 'Has history — archived instead of deleted.',
      })
    } else {
      deleted++
    }
  }

  return { updated: deleted, skipped }
}

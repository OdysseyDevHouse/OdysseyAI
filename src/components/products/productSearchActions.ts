'use server'

import { actorForOrThrow } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { listProducts, type ProductSort } from '@/lib/site/products'
import { compileListFilters, filterableFields } from '@/lib/site/listFilterSql'
import { decodeFilters } from '@/lib/listFilters'
import { getCostBasis } from '@/lib/site/lookups'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { listColumnsFor } from '@/lib/site/listColumns'
import { PRODUCT_TYPES, type ProductTypeId } from '@/lib/productTypes'
import {
  PRODUCT_SEARCH_COLUMN_IDS,
  PRODUCT_SEARCH_DEFAULT_COLUMNS,
  type ProductSearchRow,
} from './productSearchColumns'

/**
 * What the product search pop-up asks the server for.
 *
 * ── WHY AN ACTION AND NOT A PAGE ─────────────────────────────────────────
 *
 * The products list screen puts every one of these knobs in the URL, which is
 * what makes a filtered catalogue linkable, reloadable and server-rendered. A
 * dialog cannot do that and should not try: the URL belongs to the screen
 * BEHIND it — an invoice being captured, a stock take in progress — and
 * rewriting it to remember which department someone browsed would put a
 * half-finished document one Back button away from being lost.
 *
 * So the dialog holds its state in React and asks for a slice at a time. Every
 * narrowing the list screen offers is still here; only where it is written
 * differs.
 *
 * ── ONE ACTION, NOT SEVERAL ──────────────────────────────────────────────
 *
 * Rows, the total, the department tree, the filterable fields and the store's
 * column set all arrive together on the first call. Split up they would be four
 * round trips between clicking "Add product" and seeing a grid, and the three
 * that never change would be re-fetched on every keystroke. `lookups` is asked
 * for once and omitted after that.
 */

export type ProductSearchRequest = {
  search?: string
  departmentId?: number | null
  productType?: string | null
  includeArchived?: boolean
  /** The advanced filter, encoded exactly as the list screens encode it. */
  filters?: string
  sort?: string
  direction?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  /** First call only: fetch the department tree, filter fields and columns. */
  withLookups?: boolean
}

export type ProductSearchLookups = {
  /** Every department by full path, sorted by it, so children sit under parents. */
  departments: { id: number; label: string }[]
  /** id -> full path, for the Department column. */
  departmentPaths: Record<number, string>
  productTypes: { id: string; name: string }[]
  /** What the advanced filter may offer, already narrowed by permission. */
  filterFields: {
    key: string
    label: string
    type: string
    numeric: boolean
    group: string
    hint: string
    options: unknown[]
  }[]
  /** The store's column set for THIS picker — never the products list's. */
  storeColumns: string[]
  costBasis: 'last' | 'average'
  /** Whether this role may read a cost. Decides if the cost columns exist. */
  showCost: boolean
  /** Whether this role may save the column set for the whole store. */
  canSetColumns: boolean
}

export type ProductSearchResponse = {
  rows: ProductSearchRow[]
  total: number
  lookups?: ProductSearchLookups
}

const SORT_IDS = new Set<string>(['description', 'code', 'created', 'edited'])
const TYPE_IDS = new Set<string>(PRODUCT_TYPES.map((t) => t.id))

/** The same server-side date formatting the products page does, and for the
 *  same reason: the site pool parses a DATETIME as though its wall-clock were
 *  UTC, so a Date crossing into the browser would be re-read in the viewer's
 *  timezone and could render the day before. See src/lib/siteDb.ts. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return ''
  return `${String(value.getUTCDate()).padStart(2, '0')} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`
}

export async function searchProductsForPickerAction(
  request: ProductSearchRequest,
): Promise<ProductSearchResponse> {
  /* The same capability the catalogue screen needs. A dialog is not a lower
     bar than a page — it reads the same rows out of the same table, and the
     caller passing different props cannot change that. */
  const { siteId, capabilities } = await actorForOrThrow('products.view')
  const showCost = can(capabilities, 'products.cost')
  const allow = (c: Capability) => can(capabilities, c)

  const pageSize = Math.min(Math.max(request.pageSize ?? 50, 1), 200)
  const page = Math.max(request.page ?? 1, 1)

  const departments = await listDepartments(siteId, true)

  /* Filtering by a department includes everything beneath it, exactly as the
     list screen does — picking "Fresh Produce" should not hide what is filed
     under its sub-levels. */
  const departmentId = Number(request.departmentId)
  const departmentIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  /* Both narrowed against the known ids rather than trusted. These reach an
     ORDER BY and a WHERE, and an action is a public endpoint however private
     the dialog that calls it looks. */
  const productType = TYPE_IDS.has(request.productType ?? '')
    ? (request.productType as ProductTypeId)
    : undefined
  const sort: ProductSort = SORT_IDS.has(request.sort ?? '')
    ? (request.sort as ProductSort)
    : 'description'
  const direction = request.direction === 'desc' ? 'desc' : 'asc'

  /* The advanced filter. Compiled server-side against the report catalog and
     re-checked against this role's permissions — the encoded string arrives
     from a browser, so the conditions in it are a request, not a grant. */
  const conditions = decodeFilters(request.filters ?? '')
  const fields = filterableFields('products', allow)
  const compiled = compileListFilters(
    'products',
    conditions,
    allow,
    new Set(fields.map((f) => f.key)),
    // listProducts aliases the table `p`.
    'p',
  )

  const { items, total } = await listProducts(siteId, {
    search: request.search,
    includeArchived: request.includeArchived === true,
    departmentIds,
    productTypes: productType ? [productType] : undefined,
    extraWhere: compiled.where,
    extraParams: compiled.params,
    sort,
    direction,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })

  const departmentPaths: Record<number, string> = Object.fromEntries(
    departments.map((d) => [d.id, departmentPath(departments, d.id)]),
  )

  /* Flattened to plain values on the way out.
   *
   * Not the Product objects: they carry Dates (see formatDate), a prices array
   * whose shape this grid does not need, and enough besides to make every
   * keystroke ship a few hundred KB. The picker renders columns, so it is sent
   * columns.
   *
   * Cost and margin are stripped HERE when the role may not read them — null
   * on the wire rather than rendered-and-hidden, so the figures never reach a
   * browser that has no business holding them. */
  const rows: ProductSearchRow[] = items.map((p) => {
    const price = p.prices.find((x) => x.isDefault) ?? p.prices[0] ?? null
    return {
      id: p.id,
      code: p.code,
      description: p.description,
      barcode: p.barcode,
      departmentId: p.departmentId,
      productType: p.productType,
      imageColor: p.imageColor,
      hasImage: !!p.imageIcon,
      hasVariants: p.hasVariants,
      variantCount: p.variantCount,
      parentId: p.parentId,
      isArchived: p.isArchived,

      cost: showCost && !p.hasVariants ? p.cost.effective : null,
      costIncl: showCost && !p.hasVariants ? p.cost.effectiveIncl : null,

      sellExcl: p.hasVariants ? null : (price?.sellExcl ?? null),
      priceIncl: p.hasVariants ? null : (price?.sellIncl ?? null),
      gpValue: showCost && !p.hasVariants ? (price?.profit ?? null) : null,
      gp: showCost && !p.hasVariants ? (price?.gp ?? null) : null,
      maxDiscountPct: p.maxDiscountPct,

      stockOnHand: p.stockOnHand,
      belowMinimum: p.belowMinimum,
      minStock: p.hasVariants ? null : p.minStock,
      maxStock: p.hasVariants ? null : p.maxStock,

      packSize: p.packSize,
      packDescription: p.packDescription,
      packWeight: p.packWeight,
      weightDescription: p.weightDescription,

      lastSold: formatDate(p.lastSoldDate),
      lastPurchase: formatDate(p.lastPurchaseDate),
      lastAdjust: formatDate(p.lastAdjustDate),
      lastStockTake: formatDate(p.lastStockTakeDate),
      edited: formatDate(p.lastEditDate),
      created: formatDate(p.createdAt),
    }
  })

  if (!request.withLookups) return { rows, total }

  const storeColumns =
    (await listColumnsFor(siteId, 'productSearch', PRODUCT_SEARCH_COLUMN_IDS)) ??
    PRODUCT_SEARCH_DEFAULT_COLUMNS

  return {
    rows,
    total,
    lookups: {
      departments: departments
        .map((d) => ({ id: d.id, label: departmentPaths[d.id] }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      departmentPaths,
      productTypes: PRODUCT_TYPES.map((t) => ({ id: t.id, name: t.name })),
      filterFields: fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        numeric: f.numeric ?? false,
        group: f.group ?? '',
        hint: f.hint ?? '',
        options: f.options ?? [],
      })),
      storeColumns: [...storeColumns],
      costBasis: await getCostBasis(siteId),
      showCost,
      canSetColumns: can(capabilities, 'setup.edit'),
    },
  }
}


'use server'

import { actorForOrThrow } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { listProducts, type ProductSort } from '@/lib/site/products'
import { compileListFilters, filterableFields } from '@/lib/site/listFilterSql'
import { decodeFilters } from '@/lib/listFilters'
import { getCostBasis } from '@/lib/site/lookups'
import { listDepartments, departmentPath, departmentFilterIds } from '@/lib/site/departments'
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
  /**
   * One department, kept for the callers that still pass one. `departmentIds`
   * below supersedes it; both are honoured, and the two are unioned.
   */
  departmentId?: number | null
  /** Several departments, each covering everything beneath it. */
  departmentIds?: number[] | null
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

/**
 * Kinds of product a particular picker must never offer.
 *
 * Set by the CALLER's own action, never by the browser — see
 * `searchProductsForPurchasePickerAction`, which hides recipes because a made
 * item cannot be bought. It is deliberately not part of ProductSearchRequest:
 * a dialog asking a server which products to hide from it is a request the
 * server should decide, and putting it on the wire would let anyone reopen the
 * question by editing the call.
 *
 * It removes the type from the FILTER DROPDOWN as well as from the rows. A
 * picker that still offers "Recipe" and then shows an empty grid reads as a
 * broken screen, not a deliberate omission.
 */
export type ProductSearchExclusions = {
  productTypes?: readonly ProductTypeId[]
}

export type ProductSearchLookups = {
  /**
   * The department tree, as `departmentTreeOptions` wants it — the dialog's
   * filter browses a level at a time rather than reading forty full paths.
   *
   * Sent as the tree rather than as ready-made TreeSelect options because the
   * options carry a tone and a picture URL, which is presentation this action
   * has no business deciding.
   */
  departments: {
    id: number
    parentId: number | null
    name: string
    color: string | null
    imageId: number | null
  }[]
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
  return runProductSearch(request, await actorForOrThrow('products.view'), null)
}

/**
 * The same grid, for a purchase order or a goods receipt.
 *
 * Two things make it a different action rather than a prop on the one above.
 *
 * ── IT IS A DIFFERENT BOUNDARY ───────────────────────────────────────────
 *
 * Guarded by `purchasing.view`, exactly as the picker it replaces was: a buyer
 * who may not price the catalogue can still order from it, and asking them for
 * `products.view` would lock the receiving screen against the people who work
 * it. Same reasoning as browseProductsForPurchaseAction.
 *
 * ── RECIPES CANNOT BE BOUGHT ─────────────────────────────────────────────
 *
 * A recipe product is MADE, not delivered. Its own stock on hand is always
 * zero — selling one consumes its components, and it has no cost of its own to
 * receive against (see productComposition.ts). Putting one on a GRV would
 * credit the supplier for something that never arrived and move stock that
 * cannot move; putting one on an order would ask them to deliver a thing the
 * shop assembles itself.
 *
 * So it is hidden here rather than merely warned about at post time. The
 * exclusion is applied on the server for the reason every filter in this file
 * is: the dialog is a public endpoint, and a hidden option in a dropdown is a
 * suggestion.
 */
export async function searchProductsForPurchasePickerAction(
  request: ProductSearchRequest,
): Promise<ProductSearchResponse> {
  return runProductSearch(request, await actorForOrThrow('purchasing.view'), {
    productTypes: ['recipe'],
  })
}

async function runProductSearch(
  request: ProductSearchRequest,
  actor: Awaited<ReturnType<typeof actorForOrThrow>>,
  exclude: ProductSearchExclusions | null,
): Promise<ProductSearchResponse> {
  const { siteId, capabilities } = actor
  const showCost = can(capabilities, 'products.cost')
  const allow = (c: Capability) => can(capabilities, c)

  const pageSize = Math.min(Math.max(request.pageSize ?? 50, 1), 200)
  const page = Math.max(request.page ?? 1, 1)

  const departments = await listDepartments(siteId, true)

  /* Filtering by a department includes everything beneath it, exactly as the
     list screen does — picking "Fresh Produce" should not hide what is filed
     under its sub-levels. */
  const picked = [...(request.departmentIds ?? []), request.departmentId].filter(
    (id): id is number => Number.isFinite(id) && Number(id) > 0,
  )
  const departmentIds = departmentFilterIds(departments, picked) ?? undefined

  /* Both narrowed against the known ids rather than trusted. These reach an
     ORDER BY and a WHERE, and an action is a public endpoint however private
     the dialog that calls it looks. */
  const excludedTypes = exclude?.productTypes ?? []
  /* An excluded type asked for by name is dropped, not honoured. Otherwise
     selecting "Recipe" in a dropdown that no longer offers it — an old tab, a
     hand-made request — would narrow the list to exactly the rows this picker
     exists to hide. */
  const requestedType = TYPE_IDS.has(request.productType ?? '')
    ? (request.productType as ProductTypeId)
    : undefined
  const productType =
    requestedType && excludedTypes.includes(requestedType) ? undefined : requestedType
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

  /* The exclusion, as a WHERE rather than by inverting `productTypes`.
   *
   * listProducts' own type filter is an inclusive list, so expressing "not a
   * recipe" through it would mean naming the other nine types — a list that
   * silently stops excluding the moment a tenth is added to productTypes.ts.
   *
   * Placed BEFORE the compiled filter's fragments, because `extraParams` is
   * positional: these placeholders must line up with these values, and
   * appending them after a filter that carries its own would shift both. */
  const excludeWhere = excludedTypes.length
    ? [
        `COALESCE(p.product_type, 'normal') NOT IN (${excludedTypes.map(() => '?').join(',')})`,
      ]
    : []

  const { items, total } = await listProducts(siteId, {
    search: request.search,
    includeArchived: request.includeArchived === true,
    departmentIds,
    productTypes: productType ? [productType] : undefined,
    extraWhere: [...excludeWhere, ...compiled.where],
    extraParams: [...excludedTypes, ...compiled.params],
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
      departments: departments.map((d) => ({
        id: d.id,
        parentId: d.parentId,
        name: d.name,
        color: d.color,
        imageId: d.posImageId,
      })),
      departmentPaths,
      /* Minus whatever this picker hides. The rows are already filtered above;
         leaving the option in the dropdown would offer a filter that can only
         ever return nothing, which reads as a bug rather than as a rule. */
      productTypes: PRODUCT_TYPES.filter((t) => !excludedTypes.includes(t.id)).map((t) => ({
        id: t.id,
        name: t.name,
      })),
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


import 'server-only'
import {
  createProduct, updateProduct, getProduct,
  type ProductInput, type Product,
} from '@/lib/site/products'
import { saveLocationLevels, locationStockFor } from '@/lib/site/stockLocations'
import { saveProductSuppliers } from '@/lib/site/productSuppliers'
import { loadLookups, norm } from '../lookups'
import { mergeForUpdate, fileSpeaksTo } from '../merge'
import { text, number, boolean, reference, departmentPath } from '../fields'
import { ensureDepartmentPath } from './departments'
import { PROBLEM, VALUE, type ApplyContext, type ExistingMode, type ImportField,
  type ImportSpec, type LookupTables, type RowOutcome } from '../spec'

/**
 * Importing products.
 *
 * The hardest of them, because a product row is not one record. It is a
 * products row, a set of prices, a per-location stock level and a supplier
 * link — four writes across three functions, only the first two of which share
 * a transaction.
 *
 * ── WHY IT IS NOT WRAPPED IN ONE TRANSACTION ─────────────────────────────
 *
 * It could be, by writing `-Tx` variants of `saveLocationLevels` and
 * `saveProductSuppliers`. That would mean a second copy of each one's
 * validation, and two copies of a validation rule is how the two come to
 * disagree. The failure that wrapping prevents — a product created without its
 * supplier link — is visible and fixable, and this reports it by name. The
 * failures wrapping introduces are quiet ones.
 *
 * So a row that writes the product but not the supplier link comes back as
 * 'created' with a warning, counted as PARTIAL — which is neither a success nor
 * a failure and should not be filed as either.
 *
 * ── THE COLUMNS ARE NOT KNOWN UNTIL THE SITE IS ──────────────────────────
 *
 * A shop with four price lists and three locations has four price columns and
 * six min/max columns that another shop does not have. Those come from
 * `groups`, expanded once the lookups load. Everything else is static.
 */

export type ProductDraft = Partial<ProductInput> & {
  departmentPath?: string
  /** priceStructureId → VAT-inclusive selling price. */
  prices?: Record<number, number>
  /** locationId → { minStock, maxStock }, either of which may be absent. */
  levels?: Record<number, { minStock?: number; maxStock?: number }>
  supplierId?: number
  supplierCode?: string
  supplierCost?: number
  supplierPackSize?: number
}

/** Prefix marking a dynamic price column, so apply can find them again. */
const PRICE = 'price:'
const MIN = 'min:'
const MAX = 'max:'

export const productSpec: ImportSpec<ProductDraft> = {
  entity: 'products',
  title: 'Products',
  singular: 'product',
  description: 'The catalogue. Departments are created as needed; everything else must exist first.',
  capability: 'products.edit',
  matchKey: 'code',

  fields: [
    text<ProductDraft>({
      key: 'code',
      label: 'Code',
      aliases: ['Code', 'Product Code', 'Item Code', 'SKU', 'Stock Code'],
      hint: 'Leave the column out entirely to have codes generated.',
      example: 'ABC001',
      max: 48,
    }),
    text<ProductDraft>({
      key: 'description',
      label: 'Description',
      aliases: ['Description', 'Product', 'Name', 'Product Name', 'Item'],
      required: true,
      example: 'Coca-Cola 2L',
      max: 190,
    }),
    text<ProductDraft>({
      key: 'barcode',
      label: 'Barcode',
      aliases: ['Barcode', 'EAN', 'UPC', 'Bar Code'],
      hint: 'Not required to be unique — several products may share one.',
      example: '5449000000996',
      max: 48,
      blankClears: true,
    }),
    text<ProductDraft>({
      key: 'extraDescription',
      label: 'Extra description',
      aliases: ['Extra Description', 'Long Description', 'Notes'],
      max: 4000,
    }),
    departmentPath<ProductDraft>({
      key: 'departmentPath',
      label: 'Department',
      aliases: ['Department', 'Category', 'Dept', 'Group'],
      hint: 'Full path. Any level that does not exist yet is created.',
      example: 'Cold Drinks › Fizzy',
    }),
    reference<ProductDraft>({
      key: 'brandId',
      label: 'Brand',
      aliases: ['Brand', 'Make', 'Manufacturer'],
      lookup: 'brand',
      table: (lookups) => lookups.brandByName,
      noun: 'brand',
      // Brands are refused rather than created: 'Coca Cola', 'Coca-Cola' and
      // 'CocaCola' would become three brands, permanently splitting the
      // catalogue with nothing to catch it. A department path has structure to
      // match on; a brand name does not.
      fix: 'Add it under Setup, or take the column out.',
      example: 'Coca-Cola',
    }),
    reference<ProductDraft>({
      key: 'sellingVatRateId',
      label: 'Selling VAT',
      aliases: ['Selling VAT', 'VAT', 'Sales VAT', 'VAT Code', 'Tax Code'],
      lookup: 'vat',
      table: (lookups) => lookups.vatSalesByCode,
      noun: 'selling VAT rate',
      fix: 'Leave the column out to use the default rate.',
      example: 'S',
    }),
    reference<ProductDraft>({
      key: 'purchaseVatRateId',
      label: 'Purchase VAT',
      aliases: ['Purchase VAT', 'Buying VAT', 'Input VAT'],
      lookup: 'vat',
      table: (lookups) => lookups.vatPurchaseByCode,
      noun: 'purchase VAT rate',
      fix: 'Leave the column out to use the default rate.',
    }),
    number<ProductDraft>({
      key: 'lastCost',
      label: 'Cost',
      aliases: ['Cost', 'Last Cost', 'Unit Cost', 'Buy Price', 'Cost Price'],
      hint: 'Excluding VAT.',
      min: 0,
      example: '12.50',
    }),
    number<ProductDraft>({
      key: 'openingStock',
      label: 'Opening stock',
      aliases: ['Opening Stock', 'Stock', 'Qty', 'Quantity', 'On Hand', 'Stock On Hand'],
      hint: 'Only on a product being created. An existing product\'s stock moves through a stock take or an adjustment.',
      min: 0,
      example: '24',
    }),
    text<ProductDraft>({
      key: 'supplierCode',
      label: 'Supplier code',
      aliases: ['Supplier', 'Supplier Code', 'Vendor', 'Vendor Code'],
      hint: 'Their code for this product goes in the next column.',
      example: 'SUP001',
      max: 32,
    }),
    number<ProductDraft>({
      key: 'supplierCost',
      label: 'Supplier cost',
      aliases: ['Supplier Cost', 'Supplier Price', 'Vendor Cost'],
      min: 0,
    }),
    number<ProductDraft>({
      key: 'supplierPackSize',
      label: 'Supplier pack size',
      aliases: ['Supplier Pack Size', 'Pack Qty', 'Case Size'],
      min: 0,
    }),
    number<ProductDraft>({
      key: 'packSize',
      label: 'Pack size',
      aliases: ['Pack Size'],
      min: 0,
    }),
    text<ProductDraft>({
      key: 'packDescription',
      label: 'Pack description',
      aliases: ['Pack Description', 'Unit', 'UOM'],
      example: 'Each',
      max: 60,
    }),
    number<ProductDraft>({
      key: 'maxDiscountPct',
      label: 'Max discount %',
      aliases: ['Max Discount', 'Max Discount %', 'Maximum Discount'],
      min: 0,
      max: 100,
    }),
    boolean<ProductDraft>({
      key: 'visibleInPos',
      label: 'Show on till',
      aliases: ['Show On Till', 'Visible In POS', 'Visible', 'Active'],
      example: 'Yes',
    }),
    boolean<ProductDraft>({
      key: 'allowFractions',
      label: 'Allow fractions',
      aliases: ['Allow Fractions', 'Fractions', 'Decimal Qty'],
    }),
    boolean<ProductDraft>({
      key: 'scaleItem',
      label: 'Scale item',
      aliases: ['Scale Item', 'Weighed', 'Scale'],
    }),
    boolean<ProductDraft>({
      key: 'isArchived',
      label: 'Archived',
      aliases: ['Archived', 'Discontinued', 'Inactive'],
    }),
  ],

  groups: [
    // One column per price list, and per location a Min and a Max. Both
    // families are the site's own data, so they cannot be written down here.
    (lookups) => priceFields(lookups),
    (lookups) => levelFields(lookups),
  ],

  nest: nestDynamic as (draft: Record<string, unknown>) => Record<string, unknown>,

  validateRow(draft) {
    const levels = draft.levels as ProductDraft['levels']
    for (const [, pair] of Object.entries(levels ?? {})) {
      const min = pair.minStock
      const max = pair.maxStock
      // A zero maximum means 'no ceiling', which is why it is not simply min<max.
      if (min !== undefined && max !== undefined && max !== 0 && min > max) {
        return `A minimum of ${min} is above the maximum of ${max}.`
      }
    }
    if (draft.supplierCost !== undefined && !draft.supplierCode) {
      return 'A supplier cost needs a supplier code to go with it.'
    }
    return null
  },

  loadLookups: (siteId) =>
    loadLookups(siteId, {
      departments: true,
      brands: true,
      vat: true,
      priceStructures: true,
      locations: true,
      suppliers: true,
      existing: 'products',
    }),

  async applyRow(
    ctx: ApplyContext,
    raw: Record<string, unknown>,
    existingId: number | null,
    mode: ExistingMode,
  ): Promise<RowOutcome> {
    const draft = raw as ProductDraft
    const base = { line: 0, code: String(draft.code ?? '') }

    if (existingId !== null && mode === 'skip') {
      return { ...base, status: 'skipped', reason: 'Already on file.' }
    }

    const warnings: { step: string; reason: string }[] = []

    // ── The department, which is the one thing created on the way in ──
    let departmentId: number | undefined
    if (draft.departmentPath) {
      const walked = await ensureDepartmentPath(ctx.siteId, ctx.lookups, draft.departmentPath)
      if (!walked.ok) return { ...base, status: 'failed', reason: walked.error }
      departmentId = walked.id
    }

    const supplierId = draft.supplierCode
      ? ctx.lookups.supplierByCode.get(norm(draft.supplierCode))
      : undefined
    if (draft.supplierCode && supplierId === undefined) {
      return {
        ...base,
        status: 'failed',
        reason: `No supplier with the code "${draft.supplierCode}". Import suppliers first.`,
      }
    }

    // ── A. The product itself, with its prices and opening stock ──────
    // insertProductTx makes these one transaction, so this group is atomic.
    const input = productInput(draft, departmentId)
    let productId: number

    if (existingId !== null) {
      const existing = await getProduct(ctx.siteId, existingId)
      if (!existing) return { ...base, status: 'failed', reason: 'It was deleted while this ran.' }

      // Opening stock is a create-only idea: updateProduct refuses to write
      // stock_on_hand at all, because stock is a consequence of movements.
      // Saying so beats appearing to accept the column and ignoring it.
      if (ctx.mapped.has('openingStock')) {
        warnings.push({
          step: 'Opening stock',
          reason: 'Ignored on a product that already exists — use a stock take or an adjustment.',
        })
      }

      // `mapped` holds COLUMN keys — 'price:3', 'min:1' — while the draft has
      // been nested into `prices` and `levels`. So the nested keys are added
      // here, or a mapped price column would be overlaid by the stored prices
      // and the file would appear to do nothing.
      const mapped = new Set(ctx.mapped)
      if ([...ctx.mapped].some((k) => k.startsWith(PRICE))) mapped.add('prices')

      const merged = mergeForUpdate(toInput(existing), input as Record<string, unknown>, mapped)

      // A file naming Retail must not clear Wholesale: writePrices upserts per
      // named structure, so the stored prices are carried through and only the
      // ones the file actually mapped are overwritten.
      merged.prices = { ...toInput(existing).prices, ...(input.prices ?? {}) }

      const result = await updateProduct(ctx.siteId, existingId, merged)
      if (!result.ok) return { ...base, status: 'failed', reason: result.error }
      productId = existingId
    } else {
      const result = await createProduct(ctx.siteId, input)
      if (!result.ok) return { ...base, status: 'failed', reason: result.error }
      productId = result.id
    }

    // ── B. Reorder levels, one call per location ──────────────────────
    // Per location so one bad pair does not cost the other two their levels.
    for (const [locationId, pair] of Object.entries(draft.levels ?? {})) {
      const current = existingId !== null
        ? await currentLevels(ctx, productId, Number(locationId))
        : { minStock: 0, maxStock: 0 }

      const result = await saveLocationLevels(ctx.siteId, productId, Number(locationId), {
        minStock: pair.minStock ?? current.minStock,
        maxStock: pair.maxStock ?? current.maxStock,
      })
      if (!result.ok) {
        warnings.push({ step: `Reorder levels (${locationName(ctx, Number(locationId))})`, reason: result.error })
      }
    }

    // ── C. The supplier link ──────────────────────────────────────────
    // ONLY when the file actually carried a supplier column. saveProductSuppliers
    // REPLACES the whole set, so calling it unconditionally would strip every
    // supplier off every product in a file that never mentioned suppliers.
    if (supplierId !== undefined && fileSpeaksTo(ctx.mapped, 'supplierCode')) {
      const result = await saveProductSuppliers(ctx.siteId, productId, [{
        supplierId,
        lastCost: draft.supplierCost ?? draft.lastCost ?? 0,
        packSize: draft.supplierPackSize && draft.supplierPackSize > 0 ? draft.supplierPackSize : 1,
        isPreferred: true,
      }])
      if (!result.ok) warnings.push({ step: 'Supplier link', reason: result.error })
    }

    return {
      ...base,
      status: existingId !== null ? 'updated' : 'created',
      id: productId,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  },
}

/* ── Dynamic columns ──────────────────────────────────────────────────── */

function priceFields(lookups: LookupTables): ImportField<ProductDraft>[] {
  // The Map holds each structure under several aliases; one column per id.
  const seen = new Map<number, string>()
  for (const [name, id] of lookups.priceStructureByName) {
    if (!seen.has(id) && !/^PRICE \d+$/.test(name)) seen.set(id, name)
  }

  return [...seen.entries()].map(([id, name]) => ({
    key: `${PRICE}${id}`,
    label: titleCase(name),
    aliases: [titleCase(name), `${titleCase(name)} Price`, `Price ${titleCase(name)}`],
    lookup: 'priceList' as const,
    hint: 'Selling price, INCLUDING VAT.',
    example: '24.99',
    parse: (cell) => {
      const value = parseMoney(cell.text)
      if (value === null) {
        return PROBLEM(`"${cell.text}" is not a price. Write it as 24.99, including VAT.`)
      }
      if (value < 0) return PROBLEM('A selling price cannot be negative.')
      return VALUE(value)
    },
  }))
}

function levelFields(lookups: LookupTables): ImportField<ProductDraft>[] {
  const seen = new Map<number, string>()
  for (const [key, id] of lookups.locationByCode) if (!seen.has(id)) seen.set(id, key)

  return [...seen.entries()].flatMap(([id, name]) => {
    const label = titleCase(name)
    return [
      {
        key: `${MIN}${id}`,
        label: `Min (${label})`,
        aliases: [`Min ${label}`, `Minimum ${label}`, `${label} Min`, `Reorder Level ${label}`],
        lookup: 'location' as const,
        hint: 'Reorder level, for this location only.',
        parse: levelParse('minimum'),
      },
      {
        key: `${MAX}${id}`,
        label: `Max (${label})`,
        aliases: [`Max ${label}`, `Maximum ${label}`, `${label} Max`],
        lookup: 'location' as const,
        hint: 'Zero means no ceiling.',
        parse: levelParse('maximum'),
      },
    ]
  })
}

const levelParse = (noun: string) => (cell: { text: string }) => {
  const value = parseMoney(cell.text)
  if (value === null) return PROBLEM(`"${cell.text}" is not a number.`)
  if (value < 0) return PROBLEM(`A ${noun} level cannot be negative.`)
  return VALUE(value)
}

/**
 * Folds the flat draft the plan produced into the nested shape apply needs.
 *
 * The plan writes one key per column — `price:3`, `min:1` — because that is
 * what a mapping is. Apply wants `prices` and `levels` as objects. Doing it
 * here keeps the plan honest about columns and the spec honest about records.
 */
export function nestDynamic(draft: Record<string, unknown>): ProductDraft {
  const out: ProductDraft = { ...(draft as ProductDraft) }
  const prices: Record<number, number> = {}
  const levels: Record<number, { minStock?: number; maxStock?: number }> = {}

  for (const [key, value] of Object.entries(draft)) {
    if (typeof value !== 'number') continue
    if (key.startsWith(PRICE)) prices[Number(key.slice(PRICE.length))] = value
    else if (key.startsWith(MIN)) {
      const id = Number(key.slice(MIN.length))
      levels[id] = { ...levels[id], minStock: value }
    } else if (key.startsWith(MAX)) {
      const id = Number(key.slice(MAX.length))
      levels[id] = { ...levels[id], maxStock: value }
    }
  }

  if (Object.keys(prices).length > 0) out.prices = prices
  if (Object.keys(levels).length > 0) out.levels = levels
  return out
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function productInput(draft: ProductDraft, departmentId: number | undefined): ProductInput {
  const {
    departmentPath: _path, levels: _levels,
    supplierCode: _sc, supplierCost: _scost, supplierPackSize: _sps,
    ...rest
  } = draft
  void _path; void _levels; void _sc; void _scost; void _sps

  return {
    ...rest,
    code: String(draft.code ?? ''),
    description: String(draft.description ?? ''),
    ...(departmentId !== undefined ? { departmentId } : {}),
  }
}

/**
 * The stored product as the shape its own update function takes.
 *
 * `prices` needs converting rather than dropping: the read model carries a
 * ProductPrice[] with every derived figure on it, while the input wants a plain
 * id → inclusive-price map. Passing the stored prices through is what keeps a
 * file that names only Retail from clearing Wholesale.
 */
function toInput(product: Product): ProductInput {
  const prices: Record<number, number> = {}
  for (const price of product.prices) prices[price.priceStructureId] = price.sellIncl

  return {
    code: product.code,
    barcode: product.barcode,
    description: product.description,
    extraDescription: product.extraDescription,
    productType: product.productType,
    isManufactured: product.isManufactured,
    departmentId: product.departmentId,
    brandId: product.brandId,
    imageColor: product.imageColor,
    purchaseVatRateId: product.purchaseVatRateId,
    sellingVatRateId: product.sellingVatRateId,
    lastCost: product.cost.lastCost,
    isArchived: product.isArchived,

    visibleInPos: product.visibleInPos,
    changeDescription: product.changeDescription,
    askPriceAtSale: product.askPriceAtSale,
    allowFractions: product.allowFractions,
    chargePctSubtotal: product.chargePctSubtotal,
    nonGpProduct: product.nonGpProduct,
    maxDiscountPct: product.maxDiscountPct,
    variableType: product.variableType,
    priceCalc: product.priceCalc,

    packWeight: product.packWeight,
    weightDescription: product.weightDescription,
    packSize: product.packSize,
    packDescription: product.packDescription,
    lengthMm: product.lengthMm,
    widthMm: product.widthMm,
    heightMm: product.heightMm,
    prepTimeMinutes: product.prepTimeMinutes,

    scaleItem: product.scaleItem,
    labelScaleItem: product.labelScaleItem,
    fixedPriceScale: product.fixedPriceScale,
    expiresInDays: product.expiresInDays,

    prices,
  }
}

async function currentLevels(
  ctx: ApplyContext,
  productId: number,
  locationId: number,
): Promise<{ minStock: number; maxStock: number }> {
  // A file naming only a minimum must not reset the maximum to zero, which
  // saveLocationLevels would read as 'no ceiling'.
  const rows = await locationStockFor(ctx.siteId, productId)
  const row = rows.find((r) => r.locationId === locationId)
  return { minStock: row?.minStock ?? 0, maxStock: row?.maxStock ?? 0 }
}

function locationName(ctx: ApplyContext, id: number): string {
  for (const [name, value] of ctx.lookups.locationByCode) if (value === id) return titleCase(name)
  return `location ${id}`
}

const titleCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()

/** Money without the strictness of a full parse — blank is absent, not zero. */
function parseMoney(text: string): number | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  const value = Number(cleaned.replace(/[R$€£\s]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

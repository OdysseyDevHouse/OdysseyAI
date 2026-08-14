import 'server-only'
import { saveSupplierPrice } from '@/lib/site/supplierPrices'
import { loadLookups, norm } from '../lookups'
import { text, number, date } from '../fields'
import {
  PROBLEM, SKIP, VALUE,
  type ApplyContext, type Cell, type ExistingMode, type ImportSpec, type RowOutcome,
} from '../spec'

/**
 * Importing a supplier's price list.
 *
 * ── WHAT IT WRITES, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * Rows land in `supplier_prices` — what the supplier SAID they would charge,
 * from a date — via the same upsert the rest of the app uses, so re-loading a
 * corrected list fixes lines rather than stacking duplicates. It deliberately
 * does NOT touch `product_suppliers.last_cost`: that is what we happened to
 * pay last time, a fact about history that only a goods receipt may move.
 *
 * ── FINDING THE PRODUCT ──────────────────────────────────────────────────
 *
 * A supplier's spreadsheet rarely speaks our product codes; it speaks
 * barcodes. So a row may name either — OUR code wins when both are present —
 * and barcode resolution covers the main barcode and every 143 alias. A
 * barcode two products share is refused by name rather than guessed: filing a
 * price against whichever product loaded first is a silent mispricing this
 * import exists to prevent.
 */

export type SupplierPriceDraft = {
  supplierCode?: string
  productCode?: string
  barcode?: string
  effectiveFrom?: string
  costExcl?: number
  packSize?: number
  listReference?: string
  note?: string
}

export const supplierPriceSpec: ImportSpec<SupplierPriceDraft> = {
  entity: 'supplier-prices',
  title: 'Supplier prices',
  singular: 'supplier price',
  description:
    'A price list a supplier sent — what they will charge, from a date. Products are matched by your code or by barcode.',
  capability: 'purchasing.edit',
  // Rows on products already on file show as updates — which is what recording
  // a new price against an existing product is. A row whose code matches
  // nothing falls to the create path, where the barcode gets its chance.
  matchKey: 'productCode',

  fields: [
    text<SupplierPriceDraft>({
      key: 'supplierCode',
      label: 'Supplier code',
      aliases: ['Supplier', 'Supplier Code', 'Vendor', 'Vendor Code'],
      required: true,
      lookup: 'supplier',
      hint: 'Your code for the supplier this list came from.',
      example: 'SUP001',
      max: 32,
    }),
    text<SupplierPriceDraft>({
      key: 'productCode',
      label: 'Product code',
      aliases: ['Code', 'Product Code', 'Item Code', 'SKU', 'Stock Code'],
      hint: 'Your code. Leave blank on rows identified by barcode instead.',
      example: 'ABC001',
      max: 48,
    }),
    text<SupplierPriceDraft>({
      key: 'barcode',
      label: 'Barcode',
      aliases: ['Barcode', 'EAN', 'UPC', 'Bar Code'],
      hint: 'Any barcode the product carries, aliases included. Used when the code column is blank.',
      example: '5449000000996',
      max: 48,
    }),
    {
      key: 'costExcl',
      label: 'Cost',
      aliases: ['Cost', 'Price', 'Cost Price', 'Unit Cost', 'Cost Excl', 'New Price'],
      required: true,
      hint: 'What they will charge, EXCLUDING VAT.',
      example: '12.50',
      parse: (cell: Cell) => {
        const cleaned = cell.text.trim().replace(/[R$€£\s]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')
        if (!cleaned) return SKIP
        const value = Number(cleaned)
        if (!Number.isFinite(value)) {
          return PROBLEM(`"${cell.text}" is not a price. Write it as 12.50, excluding VAT.`)
        }
        if (value < 0) return PROBLEM('A cost cannot be negative.')
        return VALUE(value)
      },
    },
    date<SupplierPriceDraft>({
      key: 'effectiveFrom',
      label: 'Effective from',
      aliases: ['Effective From', 'From', 'Valid From', 'Start Date', 'Date'],
      hint: 'The day the price starts applying. Blank means today.',
      example: '2026-09-01',
    }),
    number<SupplierPriceDraft>({
      key: 'packSize',
      label: 'Pack size',
      aliases: ['Pack Size', 'Pack Qty', 'Case Size', 'Case Qty'],
      min: 0,
      hint: 'How many of your units come in one of their cases at this price.',
      example: '6',
    }),
    text<SupplierPriceDraft>({
      key: 'listReference',
      label: 'List reference',
      aliases: ['List Reference', 'Reference', 'Price List', 'List'],
      hint: 'Their name for the list, quoted when querying an invoice.',
      example: 'March 2026 list',
      max: 60,
    }),
    text<SupplierPriceDraft>({
      key: 'note',
      label: 'Note',
      aliases: ['Note', 'Notes', 'Comment'],
      max: 190,
    }),
  ],

  validateRow(draft, lookups) {
    const d = draft as SupplierPriceDraft
    if (!d.productCode?.trim() && !d.barcode?.trim()) {
      return 'Name the product — by your code, or by barcode.'
    }
    if (d.barcode?.trim() && !d.productCode?.trim()) {
      const key = norm(d.barcode)
      if (lookups.barcodeAmbiguous.has(key)) {
        return `More than one product carries the barcode "${d.barcode.trim()}". Use the product code for this row.`
      }
      if (!lookups.productIdByBarcode.has(key)) {
        return `No product carries the barcode "${d.barcode.trim()}".`
      }
    }
    if (d.costExcl === undefined) return 'Every row needs its cost.'
    return null
  },

  loadLookups: (siteId) =>
    loadLookups(siteId, {
      suppliers: true,
      productBarcodes: true,
      existing: 'products',
    }),

  async applyRow(
    ctx: ApplyContext,
    raw: Record<string, unknown>,
    existingId: number | null,
    _mode: ExistingMode,
  ): Promise<RowOutcome> {
    const draft = raw as SupplierPriceDraft
    const base = { line: 0, code: String(draft.productCode ?? draft.barcode ?? '') }

    const supplierId = draft.supplierCode
      ? ctx.lookups.supplierByCode.get(norm(draft.supplierCode))
      : undefined
    if (supplierId === undefined) {
      return {
        ...base,
        status: 'failed',
        reason: `No supplier with the code "${draft.supplierCode ?? ''}". Import suppliers first.`,
      }
    }

    // OUR code wins when both are present — it is the more deliberate claim.
    let productId = existingId
    if (productId === null && draft.barcode?.trim()) {
      productId = ctx.lookups.productIdByBarcode.get(norm(draft.barcode)) ?? null
    }
    if (productId === null) {
      return {
        ...base,
        status: 'failed',
        reason: draft.productCode?.trim()
          ? `No product with the code "${draft.productCode.trim()}".`
          : `No product carries the barcode "${draft.barcode?.trim() ?? ''}".`,
      }
    }

    const result = await saveSupplierPrice(ctx.siteId, {
      supplierId,
      productId,
      effectiveFrom: draft.effectiveFrom ?? localTodayIso(),
      costExcl: draft.costExcl ?? 0,
      packSize: draft.packSize && draft.packSize > 0 ? draft.packSize : 1,
      listReference: draft.listReference || null,
      note: draft.note || null,
    })
    if (!result.ok) return { ...base, status: 'failed', reason: result.error }

    return {
      ...base,
      status: existingId !== null ? 'updated' : 'created',
      id: result.id,
    }
  },
}

function localTodayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

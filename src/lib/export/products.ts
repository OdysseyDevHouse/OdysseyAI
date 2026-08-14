import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { productSpec } from '@/lib/import/specs/products'
import { fieldsFor } from '@/lib/import/spec'
import type { ExportColumn } from './table'

/**
 * The catalogue as a spreadsheet SHAPED FOR RE-IMPORT.
 *
 * ── THE HEADERS COME FROM THE IMPORT SPEC ────────────────────────────────
 *
 * Every column's heading is the import field's own first alias, taken from
 * the spec at run time rather than copied here — so export → edit in Excel →
 * import maps every column automatically BY CONSTRUCTION, and a heading
 * renamed in the spec renames itself here. The one deliberate omission is
 * Opening Stock: stock is a consequence of movements, and a re-imported
 * quantity column pretending otherwise is exactly the mistake the import
 * warns about.
 *
 * Alias barcodes are joined with '|', the import's own separator.
 */

type Row = RowDataPacket & Record<string, unknown>

export type CatalogueExport = {
  columns: ExportColumn<Record<string, unknown>>[]
  rows: Record<string, unknown>[]
}

const MONEY_KEYS = new Set(['lastCost', 'supplierCost'])

export async function catalogueExport(siteId: number): Promise<CatalogueExport> {
  const lookups = await productSpec.loadLookups(siteId)
  const fields = fieldsFor(productSpec, lookups).filter((f) => f.key !== 'openingStock')

  const [products, departments, brands, vatRates, barcodes, prices, levels, supplierLinks] =
    await Promise.all([
      siteQuery<Row>(
        siteId,
        `SELECT * FROM products WHERE is_archived = 0 ORDER BY description, id`,
      ),
      siteQuery<Row>(siteId, 'SELECT id, parent_id, name FROM departments'),
      siteQuery<Row>(siteId, 'SELECT id, name FROM brands'),
      siteQuery<Row>(siteId, 'SELECT id, code FROM vat_rates'),
      siteQuery<Row>(
        siteId,
        `SELECT product_id, GROUP_CONCAT(barcode ORDER BY id SEPARATOR '|') AS list
           FROM product_barcodes GROUP BY product_id`,
      ),
      siteQuery<Row>(siteId, 'SELECT product_id, price_structure_id, selling_price_incl FROM product_prices'),
      siteQuery<Row>(
        siteId,
        'SELECT product_id, location_id, min_stock, max_stock FROM product_location_stock',
      ),
      siteQuery<Row>(
        siteId,
        `SELECT ps.product_id, ps.last_cost, ps.pack_size, s.code AS supplier_code
           FROM product_suppliers ps
           JOIN suppliers s ON s.id = ps.supplier_id
          WHERE ps.is_preferred = 1`,
      ),
    ])

  // Display paths, walked the same way the import walks them in.
  const deptById = new Map(departments.map((d) => [Number(d.id), d]))
  const pathOf = (id: number | null): string => {
    const parts: string[] = []
    let cursor = id
    for (let depth = 0; cursor !== null && depth <= departments.length; depth++) {
      const row = deptById.get(cursor)
      if (!row) break
      parts.unshift(String(row.name).trim())
      cursor = row.parent_id === null ? null : Number(row.parent_id)
    }
    return parts.join(' › ')
  }

  const brandById = new Map(brands.map((b) => [Number(b.id), String(b.name)]))
  const vatById = new Map(vatRates.map((v) => [Number(v.id), String(v.code)]))
  const barcodesById = new Map(barcodes.map((b) => [Number(b.product_id), String(b.list)]))
  const supplierById = new Map(supplierLinks.map((s) => [Number(s.product_id), s]))

  const pricesById = new Map<number, Map<number, number>>()
  for (const p of prices) {
    const slot = pricesById.get(Number(p.product_id)) ?? new Map<number, number>()
    slot.set(Number(p.price_structure_id), toNum(p.selling_price_incl))
    pricesById.set(Number(p.product_id), slot)
  }

  const levelsById = new Map<number, Map<number, { min: number; max: number }>>()
  for (const l of levels) {
    const slot = levelsById.get(Number(l.product_id)) ?? new Map()
    slot.set(Number(l.location_id), { min: toNum(l.min_stock), max: toNum(l.max_stock) })
    levelsById.set(Number(l.product_id), slot)
  }

  const yesNo = (v: unknown) => (Number(v) === 1 ? 'Yes' : 'No')

  const rows = products.map((p) => {
    const id = Number(p.id)
    const link = supplierById.get(id)
    const record: Record<string, unknown> = {
      code: String(p.code ?? ''),
      description: String(p.description ?? ''),
      barcode: String(p.barcode ?? ''),
      extraBarcodes: barcodesById.get(id) ?? '',
      extraDescription: String(p.extra_description ?? ''),
      departmentPath: pathOf(p.department_id === null ? null : Number(p.department_id)),
      brandId: p.brand_id === null ? '' : (brandById.get(Number(p.brand_id)) ?? ''),
      sellingVatRateId:
        p.selling_vat_rate_id === null ? '' : (vatById.get(Number(p.selling_vat_rate_id)) ?? ''),
      purchaseVatRateId:
        p.purchase_vat_rate_id === null ? '' : (vatById.get(Number(p.purchase_vat_rate_id)) ?? ''),
      lastCost: toNum(p.last_cost),
      supplierCode: link ? String(link.supplier_code) : '',
      supplierCost: link ? toNum(link.last_cost) : '',
      supplierPackSize: link ? toNum(link.pack_size) : '',
      packSize: toNum(p.pack_size),
      packDescription: String(p.pack_description ?? ''),
      maxDiscountPct: toNum(p.max_discount_pct),
      visibleInPos: yesNo(p.visible_in_pos),
      allowFractions: yesNo(p.allow_fractions),
      scaleItem: yesNo(p.scale_item),
      isArchived: yesNo(p.is_archived),
    }
    for (const [structureId, price] of pricesById.get(id) ?? []) {
      record[`price:${structureId}`] = price
    }
    for (const [locationId, pair] of levelsById.get(id) ?? []) {
      record[`min:${locationId}`] = pair.min
      record[`max:${locationId}`] = pair.max
    }
    return record
  })

  const columns: ExportColumn<Record<string, unknown>>[] = fields.map((field) => ({
    // The FIRST alias is what the import's own template writes, so the round
    // trip closes by construction.
    header: field.aliases[0],
    value: (row) => {
      const value = row[field.key]
      if (value === undefined || value === null) return ''
      return value as string | number
    },
    money: MONEY_KEYS.has(field.key) || field.key.startsWith('price:'),
  }))

  return { columns, rows }
}

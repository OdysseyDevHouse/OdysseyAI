import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '@/lib/siteDb'
import { emptyLookups, type LookupTables } from './spec'

/**
 * Everything a run resolves against, loaded once.
 *
 * ── ONCE, NOT PER ROW ────────────────────────────────────────────────────
 *
 * A 20,000-row product file naming a department, a brand, a VAT code and a
 * supplier per row is 80,000 queries if each row resolves its own. Loaded up
 * front it is eight small SELECTs and a few hundred kilobytes of Maps, and the
 * validation pass then runs with no database at all — which is also what lets
 * the identical pass run in the browser for the preview.
 *
 * ── KEYS ARE NORMALISED ──────────────────────────────────────────────────
 *
 * A spreadsheet writes 'FRESH PRODUCE' where the tree holds 'Fresh Produce',
 * and they are the same department. Every Map here is keyed on the upper-cased,
 * trimmed form, and every `parse` looks up the same way.
 */

export const norm = (value: string): string => value.trim().toUpperCase()

/** The separator between levels of a department path, in files and on screen. */
export const PATH_SEPARATOR = '›'

/** Splits 'Fresh Produce › Fruit › Citrus' into its segments. */
export function splitPath(value: string): string[] {
  return value
    .split(/[›>/|]|::/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

type IdName = RowDataPacket & { id: number; name: string }
type IdCode = RowDataPacket & { id: number; code: string | null }

/**
 * Loads the lookups a spec asks for.
 *
 * Each block is opt-in because a supplier import needs none of them and should
 * not pay for eight queries to find that out.
 */
export async function loadLookups(
  siteId: number,
  want: {
    departments?: boolean
    brands?: boolean
    vat?: boolean
    priceStructures?: boolean
    locations?: boolean
    suppliers?: boolean
    customerGroups?: boolean
    salesReps?: boolean
    /** Product resolution by barcode, main and 143 aliases together. */
    productBarcodes?: boolean
    /** The table whose codes decide create-vs-update for this run. */
    existing?: 'products' | 'customers' | 'suppliers' | 'departments'
  },
): Promise<LookupTables> {
  const lookups = emptyLookups()

  if (want.departments) await loadDepartments(siteId, lookups)

  if (want.brands) {
    const rows = await siteQuery<IdName>(siteId, 'SELECT id, name FROM brands')
    for (const row of rows) lookups.brandByName.set(norm(String(row.name)), Number(row.id))
  }

  if (want.vat) {
    // Keyed by code AND name: a file writes 'S' in one export and 'Standard
    // rate' in another, and both name the same rate.
    const rows = await siteQuery<RowDataPacket & {
      id: number; vat_type: string; code: string; name: string
    }>(siteId, 'SELECT id, vat_type, code, name FROM vat_rates WHERE is_active = 1')
    for (const row of rows) {
      const target = row.vat_type === 'purchase' ? lookups.vatPurchaseByCode : lookups.vatSalesByCode
      target.set(norm(String(row.code)), Number(row.id))
      target.set(norm(String(row.name)), Number(row.id))
    }
  }

  if (want.priceStructures) {
    const rows = await siteQuery<RowDataPacket & { id: number; name: string; position: number }>(
      siteId,
      'SELECT id, name, position FROM price_structures WHERE is_active = 1 ORDER BY position',
    )
    for (const row of rows) {
      lookups.priceStructureByName.set(norm(String(row.name)), Number(row.id))
      // 'Price 1' / 'Price1' is how several older systems label the columns.
      lookups.priceStructureByName.set(norm(`Price ${row.position}`), Number(row.id))
    }
  }

  if (want.locations) {
    const rows = await siteQuery<RowDataPacket & { id: number; code: string; name: string }>(
      siteId,
      'SELECT id, code, name FROM stock_locations WHERE is_active = 1',
    )
    for (const row of rows) {
      lookups.locationByCode.set(norm(String(row.code)), Number(row.id))
      lookups.locationByCode.set(norm(String(row.name)), Number(row.id))
    }
  }

  if (want.suppliers) {
    // Every supplier, closed ones included — see the note on existingIdByCode.
    const rows = await siteQuery<IdCode>(siteId, 'SELECT id, code FROM suppliers')
    for (const row of rows) {
      if (row.code) lookups.supplierByCode.set(norm(String(row.code)), Number(row.id))
    }
  }

  if (want.customerGroups) {
    const rows = await siteQuery<IdCode & { name: string }>(
      siteId,
      'SELECT id, name, code FROM customer_groups',
    )
    for (const row of rows) {
      lookups.customerGroupByName.set(norm(String(row.name)), Number(row.id))
      if (row.code) lookups.customerGroupByName.set(norm(String(row.code)), Number(row.id))
    }
  }

  if (want.salesReps) {
    const rows = await siteQuery<IdCode & { name: string }>(
      siteId,
      'SELECT id, name, code FROM sales_reps',
    )
    for (const row of rows) {
      lookups.salesRepByName.set(norm(String(row.name)), Number(row.id))
      if (row.code) lookups.salesRepByName.set(norm(String(row.code)), Number(row.id))
    }
  }

  if (want.productBarcodes) {
    // Main barcodes may be shared between products; alias barcodes (143) are
    // strictly unique but can still collide with a main barcode on ANOTHER
    // product. Every collision lands in barcodeAmbiguous, so a file using it
    // is asked for the product code rather than guessing.
    const rows = await siteQuery<RowDataPacket & { product_id: number; barcode: string }>(
      siteId,
      `SELECT id AS product_id, barcode FROM products
        WHERE barcode IS NOT NULL AND barcode <> '' AND is_archived = 0
       UNION ALL
       SELECT pb.product_id, pb.barcode FROM product_barcodes pb
        JOIN products p ON p.id = pb.product_id AND p.is_archived = 0`,
    )
    for (const row of rows) {
      const key = norm(String(row.barcode))
      const held = lookups.productIdByBarcode.get(key)
      if (held !== undefined && held !== Number(row.product_id)) {
        lookups.barcodeAmbiguous.add(key)
        lookups.productIdByBarcode.delete(key)
      } else if (!lookups.barcodeAmbiguous.has(key)) {
        lookups.productIdByBarcode.set(key, Number(row.product_id))
      }
    }
  }

  if (want.existing) await loadExisting(siteId, want.existing, lookups)

  return lookups
}

/**
 * Every existing code for the entity being imported.
 *
 * A RAW query on purpose. `listCustomers`/`listSuppliers` exclude 'closed' by
 * default and clamp to 500 rows; using either here would miss a closed account,
 * so the import would try to CREATE its code, hit the unique index, and hand
 * the user "already in use" about a record they cannot see in the list.
 */
async function loadExisting(
  siteId: number,
  table: 'products' | 'customers' | 'suppliers' | 'departments',
  lookups: LookupTables,
): Promise<void> {
  if (table === 'departments') {
    // Departments match on their path, which loadDepartments already built.
    for (const [path, id] of lookups.departmentByPath) lookups.existingIdByCode.set(path, id)
    return
  }

  const rows = await siteQuery<IdCode>(siteId, `SELECT id, code FROM ${table}`)
  for (const row of rows) {
    if (row.code) lookups.existingIdByCode.set(norm(String(row.code)), Number(row.id))
  }
}

/**
 * The department tree, keyed by full path and by unambiguous leaf name.
 *
 * Both keys exist because both spellings turn up. A tidy export writes 'Fresh
 * Produce › Fruit'; a spreadsheet somebody keeps by hand writes 'Fruit'. The
 * bare name resolves only while it names exactly one department — the moment
 * two branches both have a 'Fruit', it is recorded as ambiguous and a row using
 * it is asked for the full path rather than being silently filed under whichever
 * one loaded first.
 */
async function loadDepartments(siteId: number, lookups: LookupTables): Promise<void> {
  const rows = await siteQuery<RowDataPacket & {
    id: number; parent_id: number | null; name: string
  }>(siteId, 'SELECT id, parent_id, name FROM departments')

  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const pathOf = (id: number): string => {
    const parts: string[] = []
    let cursor: number | null = id
    // Bounded by the row count: a cycle would otherwise spin forever, and the
    // schema's RESTRICT does not prevent one being written by hand.
    for (let depth = 0; cursor != null && depth <= rows.length; depth++) {
      const row = byId.get(cursor)
      if (!row) break
      parts.unshift(String(row.name).trim())
      cursor = row.parent_id == null ? null : Number(row.parent_id)
    }
    return parts.join(` ${PATH_SEPARATOR} `)
  }

  const leafCount = new Map<string, number>()
  for (const row of rows) {
    const key = norm(String(row.name))
    leafCount.set(key, (leafCount.get(key) ?? 0) + 1)
  }

  for (const row of rows) {
    const id = Number(row.id)
    lookups.departmentByPath.set(norm(pathOf(id)), id)

    const leaf = norm(String(row.name))
    if ((leafCount.get(leaf) ?? 0) > 1) lookups.departmentAmbiguous.add(leaf)
    else lookups.departmentByPath.set(leaf, id)
  }
}

import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { supplierDbPrefix, supplierQueryOne } from './customerDb'
import { round, toNum } from '../decimals'
import { todayIso } from './purchaseDocuments'

/**
 * What a supplier has agreed to charge, and from when.
 *
 * product_suppliers.last_cost is what we HAPPENED TO PAY last time — a fact
 * about history that moves with every receipt and carries whatever one-off
 * deal came with that delivery. This is what they said they would charge, and
 * it can be captured before the goods arrive.
 *
 * ── THE EFFECTIVE-DATE RULE, WHICH IS THE WHOLE FILE ─────────────────────
 *
 * The price that applies on a date is the LATEST row whose effective_from is
 * not in the future. A list for 1 March can therefore be keyed in February and
 * simply starts working on the day it said it would.
 *
 * Everything reads AS AT a date rather than "now" for the same reason billing
 * does: an order raised last week was raised at last week's prices, and a
 * screen showing it today must not silently reprice it. See the asAt note in
 * the contracts module — the same mistake, the same fix.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SupplierPrice = {
  id: number
  supplierId: number
  supplierName: string | null
  productId: number
  productCode: string | null
  productDescription: string | null
  effectiveFrom: string
  costExcl: number
  packSize: number
  listReference: string | null
  note: string | null
  /** False once a later row has taken over. Computed, never stored. */
  isCurrent: boolean
}

function mapPrice(r: Row, currentIds?: Set<number>): SupplierPrice {
  return {
    id: Number(r.id),
    supplierId: Number(r.supplier_id),
    supplierName: (r.supplier_name as string | null) ?? null,
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    productDescription: (r.product_description as string | null) ?? null,
    effectiveFrom: String(r.effective_from),
    costExcl: toNum(r.cost_excl),
    packSize: toNum(r.pack_size) || 1,
    listReference: (r.list_reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    isCurrent: currentIds ? currentIds.has(Number(r.id)) : false,
  }
}

/**
 * The agreed cost for one product from one supplier, on a date.
 *
 * Null when they have never quoted it — the caller then falls back to
 * last_cost, which is what ordering did before this existed.
 */
export async function priceFor(
  siteId: number,
  supplierId: number,
  productId: number,
  asAt?: string,
): Promise<SupplierPrice | null> {
  // supplier_prices and products BOTH stay in the branch (206) — an agreed cost
  // is this shop's, and the price list keys into a product. Only the supplier's
  // name is remote, so the statement runs on this connection and names one
  // table. Empty for an unshared site.
  const sdb = await supplierDbPrefix(siteId)
  const on = asAt ?? todayIso()
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT sp.*, s.name AS supplier_name, p.code AS product_code, p.description AS product_description
       FROM supplier_prices sp
       JOIN ${sdb}suppliers s ON s.id = sp.supplier_id
       JOIN products  p ON p.id = sp.product_id
      WHERE sp.supplier_id = ? AND sp.product_id = ? AND sp.effective_from <= ?
      ORDER BY sp.effective_from DESC, sp.id DESC
      LIMIT 1`,
    [supplierId, productId, on],
  )
  return row ? { ...mapPrice(row), isCurrent: true } : null
}

/**
 * Agreed costs for many products at once, on a date.
 *
 * One query for a whole order rather than one per line: a fifty-line order
 * would otherwise open fifty round trips as the screen loads.
 *
 * The correlated MAX picks each product's own latest effective row — a plain
 * GROUP BY on the date would give the right date but the wrong cost, which is
 * the classic greatest-n-per-group mistake and is silent.
 */
export async function pricesFor(
  siteId: number,
  supplierId: number,
  productIds: readonly number[],
  asAt?: string,
): Promise<Map<number, SupplierPrice>> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return new Map()

  const sdb = await supplierDbPrefix(siteId)
  const on = asAt ?? todayIso()
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT sp.*, s.name AS supplier_name, p.code AS product_code, p.description AS product_description
       FROM supplier_prices sp
       JOIN ${sdb}suppliers s ON s.id = sp.supplier_id
       JOIN products  p ON p.id = sp.product_id
      WHERE sp.supplier_id = ?
        AND sp.product_id IN (${ids.map(() => '?').join(',')})
        AND sp.effective_from <= ?
        AND sp.id = (
              SELECT x.id FROM supplier_prices x
               WHERE x.supplier_id = sp.supplier_id
                 AND x.product_id  = sp.product_id
                 AND x.effective_from <= ?
               ORDER BY x.effective_from DESC, x.id DESC
               LIMIT 1
            )`,
    [supplierId, ...ids, on, on],
  )

  return new Map(rows.map((r) => [Number(r.product_id), { ...mapPrice(r), isCurrent: true }]))
}

export type PriceListOptions = {
  supplierId?: number
  productId?: number
  /** Only what applies today, hiding superseded and future rows. */
  currentOnly?: boolean
  search?: string
  limit?: number
  offset?: number
}

/** The price list for a screen, newest first within each product. */
export async function listSupplierPrices(
  siteId: number,
  opts: PriceListOptions = {},
): Promise<{ items: SupplierPrice[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.supplierId) {
    where.push('sp.supplier_id = ?')
    params.push(opts.supplierId)
  }
  if (opts.productId) {
    where.push('sp.product_id = ?')
    params.push(opts.productId)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(p.code LIKE ? OR p.description LIKE ? OR sp.list_reference LIKE ?)')
    params.push(term, term, term)
  }
  if (opts.currentOnly) {
    const on = todayIso()
    where.push(`sp.effective_from <= ? AND sp.id = (
      SELECT x.id FROM supplier_prices x
       WHERE x.supplier_id = sp.supplier_id AND x.product_id = sp.product_id
         AND x.effective_from <= ?
       ORDER BY x.effective_from DESC, x.id DESC LIMIT 1)`)
    params.push(on, on)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const offset = Math.max(opts.offset ?? 0, 0)

  const sdb = await supplierDbPrefix(siteId)
  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT sp.*, s.name AS supplier_name, p.code AS product_code, p.description AS product_description
         FROM supplier_prices sp
         JOIN ${sdb}suppliers s ON s.id = sp.supplier_id
         JOIN products  p ON p.id = sp.product_id
         ${whereSql}
        ORDER BY p.description, sp.effective_from DESC, sp.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total
         FROM supplier_prices sp
         JOIN ${sdb}suppliers s ON s.id = sp.supplier_id
         JOIN products  p ON p.id = sp.product_id
         ${whereSql}`,
      params,
    ),
  ])

  // Which of the returned rows is the one in force today. Marked here rather
  // than in SQL so the list can show superseded and future rows AND say which
  // is live — a price list nobody can read the history of is half a feature.
  const today = todayIso()
  const currentIds = new Set<number>()
  const seen = new Set<string>()
  for (const r of [...rows].sort((a, b) =>
    String(b.effective_from).localeCompare(String(a.effective_from)),
  )) {
    const key = `${r.supplier_id}:${r.product_id}`
    if (seen.has(key)) continue
    if (String(r.effective_from) <= today) {
      seen.add(key)
      currentIds.add(Number(r.id))
    }
  }

  return {
    items: rows.map((r) => mapPrice(r, currentIds)),
    total: Number(countRow?.total ?? 0),
  }
}

export type SavePriceInput = {
  supplierId: number
  productId: number
  effectiveFrom: string
  costExcl: number
  packSize?: number
  listReference?: string | null
  note?: string | null
}

export type PriceResult = { ok: true; id: number } | { ok: false; error: string }

export function validatePrice(input: SavePriceInput): string | null {
  if (!input.supplierId) return 'Choose a supplier.'
  if (!input.productId) return 'Choose a product.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom ?? '')) {
    return 'Give the date the price starts applying.'
  }
  if (!Number.isFinite(input.costExcl) || input.costExcl < 0) {
    return 'The cost cannot be negative.'
  }
  if ((input.packSize ?? 1) <= 0) return 'A pack holds at least one.'
  return null
}

/**
 * Records an agreed price.
 *
 * Upserts on (supplier, product, date): re-keying the same list line CORRECTS
 * it rather than stacking a second row behind it. Without that, a typo fixed
 * by re-entering would leave two rows for one date and the ORDER BY would pick
 * whichever the id happened to favour.
 */
export async function saveSupplierPrice(
  siteId: number,
  input: SavePriceInput,
): Promise<PriceResult> {
  const invalid = validatePrice(input)
  if (invalid) return { ok: false, error: invalid }

  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM products WHERE id = ? AND is_archived = 0 LIMIT 1',
    [input.productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }

  const supplier = await supplierQueryOne<Row>(
    siteId,
    'SELECT id, status FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'That supplier no longer exists.' }
  if (String(supplier.status) === 'closed') {
    return { ok: false, error: 'That supplier’s account is closed.' }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO supplier_prices
       (supplier_id, product_id, effective_from, cost_excl, pack_size, list_reference, note)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       cost_excl      = VALUES(cost_excl),
       pack_size      = VALUES(pack_size),
       list_reference = VALUES(list_reference),
       note           = VALUES(note)`,
    [
      input.supplierId,
      input.productId,
      input.effectiveFrom,
      round(input.costExcl, 4).toFixed(4),
      round(input.packSize ?? 1, 3).toFixed(3),
      input.listReference?.trim() || null,
      input.note?.trim() || null,
    ],
  )

  // insertId is 0 on the UPDATE branch of an upsert, so the existing row has to
  // be read back rather than assumed.
  if (result.insertId) return { ok: true, id: result.insertId }
  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM supplier_prices
      WHERE supplier_id = ? AND product_id = ? AND effective_from = ? LIMIT 1`,
    [input.supplierId, input.productId, input.effectiveFrom],
  )
  return existing
    ? { ok: true, id: Number(existing.id) }
    : { ok: false, error: 'The price could not be saved.' }
}

/**
 * Records a whole list in one go.
 *
 * A supplier sends a spreadsheet, not one price. Each line is upserted
 * independently and the failures are reported rather than rolling the lot
 * back: a hundred-line list with two unknown product codes should load
 * ninety-eight prices and say which two need looking at.
 */
export async function saveSupplierPriceList(
  siteId: number,
  lines: readonly SavePriceInput[],
): Promise<{ saved: number; errors: { index: number; error: string }[] }> {
  const errors: { index: number; error: string }[] = []
  let saved = 0

  for (const [index, line] of lines.entries()) {
    const result = await saveSupplierPrice(siteId, line)
    if (result.ok) saved++
    else errors.push({ index, error: result.error })
  }

  return { saved, errors }
}

export async function deleteSupplierPrice(
  siteId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM supplier_prices WHERE id = ? LIMIT 1',
    [id],
  )
  if (!row) return { ok: false, error: 'That price no longer exists.' }

  // Deleted outright rather than archived: a price list line is a statement of
  // what they charge, not a transaction. Nothing points at it — an order
  // snapshots its own costs at the moment it is raised, so removing a price
  // cannot change a document already written.
  await siteExecute(siteId, 'DELETE FROM supplier_prices WHERE id = ?', [id])
  return { ok: true }
}

/**
 * Which agreed prices a receipt disagreed with.
 *
 * The other half of the point: capturing what they promised is only useful if
 * somebody notices when they invoice something else. Called after a GRV posts,
 * so the variance can be shown on the document rather than found in a report
 * nobody runs.
 */
export async function priceVariances(
  siteId: number,
  documentId: number,
): Promise<
  { productId: number; description: string; agreed: number; paid: number; variance: number }[]
> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.product_id, l.description, l.unit_cost_excl, d.document_date, d.supplier_id
       FROM purchase_document_lines l
       JOIN purchase_documents d ON d.id = l.document_id
      WHERE l.document_id = ? AND l.product_id IS NOT NULL`,
    [documentId],
  )
  if (rows.length === 0) return []

  const supplierId = Number(rows[0].supplier_id)
  const asAt = String(rows[0].document_date)
  const agreed = await pricesFor(
    siteId,
    supplierId,
    rows.map((r) => Number(r.product_id)),
    asAt,
  )

  const out = []
  for (const r of rows) {
    const price = agreed.get(Number(r.product_id))
    if (!price || price.costExcl <= 0) continue
    const paid = toNum(r.unit_cost_excl)
    const variance = round(paid - price.costExcl, 4)
    if (variance === 0) continue
    out.push({
      productId: Number(r.product_id),
      description: String(r.description),
      agreed: price.costExcl,
      paid,
      variance,
    })
  }
  return out
}

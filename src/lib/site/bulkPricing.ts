import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { effectiveCost, type CostBasis } from '../pricing'
import { writePriceRows } from './reprice'
import { getCostBasis } from './lookups'
import { logActivityTx } from './activityLog'

/**
 * The bulk price editor's reads and its one write.
 *
 * The screen this serves is the manual counterpart to setup/pricing's reprice:
 * that one fills a whole tier from a RULE, this one is a person going down a
 * department adjusting individual products by eye. Neither replaces the other,
 * and they share the arithmetic (lib/pricing.ts) and the write
 * (writePriceRows) so the two can never disagree about what a price is.
 *
 * Everything derived — markup, GP, exclusive selling price — is computed in
 * the browser from the figures returned here, exactly as PricingPanel does for
 * a single product. This file ships the stored facts and nothing else.
 */

type Row = RowDataPacket & Record<string, unknown>

export type BulkPricingRow = {
  id: number
  code: string
  description: string
  /** Null when the product has no price under the selected structure yet. */
  sellingIncl: number | null
  lastCost: number
  averageCost: number
  /** Whichever of the two costs this site prices from. */
  costExcl: number
  /** Percent, for deriving the exclusive selling price in the browser. */
  sellingVatPercent: number
  /** Percent, for the inclusive cost box. */
  purchaseVatPercent: number
  purchaseVatRateId: number | null
  sellingVatRateId: number | null
  departmentName: string | null
}

export type BulkPricingOptions = {
  /** The price structure being edited. Every row's price is read for this one. */
  structureId: number
  search?: string
  departmentIds?: number[]
  /**
   * Only products this supplier sells us — the "they sent a 7% increase, put it
   * on their range" filter, which is the job this screen exists for.
   */
  supplierId?: number
  includeArchived?: boolean
  limit?: number
  offset?: number
}

/**
 * One page of products with their price under ONE structure.
 *
 * ── VARIANTS ARE NOT COLLAPSED ────────────────────────────────────────
 * listProducts() folds a variant group into its parent row, which is right for
 * a catalogue: a shirt in twenty variants is one thing on a shelf. It is wrong
 * here. Each variant carries its OWN price, so collapsing would hide most of
 * the prices in the shop behind a row whose own price may be unset. This query
 * lists leaf products — anything that is not a variant parent — so every row
 * on screen is a price that actually exists.
 */
export async function listProductsForPricing(
  siteId: number,
  opts: BulkPricingOptions,
): Promise<{ items: BulkPricingRow[]; total: number; costBasis: CostBasis }> {
  const basis = await getCostBasis(siteId)

  // A variant PARENT holds no price of its own — its children do. Excluding it
  // keeps the page from showing a row that cannot be priced.
  const where: string[] = ['p.has_variants = 0']
  const params: unknown[] = []

  if (!opts.includeArchived) where.push('p.is_archived = 0')

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    // Barcode matches exactly — a scanner sends the whole code, and a LIKE on
    // it would turn every scan into a full table scan.
    where.push('(p.description LIKE ? OR p.code LIKE ? OR p.barcode = ?)')
    params.push(term, term, opts.search.trim())
  }
  if (opts.departmentIds?.length) {
    where.push(`p.department_id IN (${opts.departmentIds.map(() => '?').join(',')})`)
    params.push(...opts.departmentIds)
  }
  /* EXISTS against the link table rather than a join to `suppliers`.
     product_suppliers always lives in THIS database, but the supplier file may
     be shared from another site's (see supplierBranchDbPrefix) — so joining the
     two here would break on exactly the sites that share a creditors book. The
     id is all the filter needs; the NAME is loaded through the sharing-aware
     helper by the caller. EXISTS also cannot duplicate a product the way a join
     to a many-side would. */
  if (opts.supplierId) {
    where.push(
      `EXISTS (SELECT 1 FROM product_suppliers ps
                WHERE ps.product_id = p.id AND ps.supplier_id = ?)`,
    )
    params.push(opts.supplierId)
  }

  const clause = where.join(' AND ')

  const totalRow = await siteQueryOne<RowDataPacket & { total: number }>(
    siteId,
    `SELECT COUNT(*) AS total FROM products p WHERE ${clause}`,
    params,
  )
  const total = Number(totalRow?.total ?? 0)

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)

  /* The price is a correlated subquery rather than a LEFT JOIN for the same
     reason planReprice uses one: a join to product_prices multiplies rows if
     that table ever gains a duplicate, and a silently doubled product list on a
     PRICING screen is the worst place to find that out. */
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.last_cost, p.average_cost,
            p.purchase_vat_rate_id, p.selling_vat_rate_id,
            d.name AS department_name,
            COALESCE(v.rate, 0)  AS selling_vat,
            COALESCE(pv.rate, 0) AS purchase_vat,
            (SELECT pp.selling_price_incl FROM product_prices pp
              WHERE pp.product_id = p.id AND pp.price_structure_id = ?) AS selling_incl
       FROM products p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN vat_rates v   ON v.id = p.selling_vat_rate_id
       LEFT JOIN vat_rates pv  ON pv.id = p.purchase_vat_rate_id
      WHERE ${clause}
      ORDER BY p.description ASC, p.id ASC
      LIMIT ${limit} OFFSET ${offset}`,
    [opts.structureId, ...params],
  )

  const items = rows.map((r) => {
    const lastCost = toNum(r.last_cost)
    const averageCost = toNum(r.average_cost)
    return {
      id: Number(r.id),
      code: String(r.code),
      description: String(r.description),
      sellingIncl: r.selling_incl === null ? null : toNum(r.selling_incl),
      lastCost,
      averageCost,
      costExcl: effectiveCost(averageCost, lastCost, basis),
      sellingVatPercent: toNum(r.selling_vat),
      purchaseVatPercent: toNum(r.purchase_vat),
      purchaseVatRateId:
        r.purchase_vat_rate_id === null ? null : Number(r.purchase_vat_rate_id),
      sellingVatRateId: r.selling_vat_rate_id === null ? null : Number(r.selling_vat_rate_id),
      departmentName: r.department_name === null ? null : String(r.department_name),
    }
  })

  return { items, total, costBasis: basis }
}

/**
 * One product's pending changes.
 *
 * Every field is optional because a row is usually only partly touched — a
 * price moved and nothing else — and sending the untouched figures back would
 * mean this screen overwriting a cost somebody else changed while it was open.
 */
export type BulkPriceEdit = {
  productId: number
  priceIncl?: number
  /** products.last_cost, EXCLUSIVE. average_cost is never written from here. */
  lastCost?: number
  purchaseVatRateId?: number | null
  sellingVatRateId?: number | null
}

export type BulkPricingSaveResult = {
  updated: number
  skipped: { id: number; reason: string }[]
}

/**
 * Commits a screenful of edited prices, costs and tax rates.
 *
 * Prices go through writePriceRows, which is the ONE definition of a price
 * write: it reads the before-picture inside the same transaction and records
 * the history rows, so a change made here shows up on the product's Price
 * history panel next to one made by the editor or a reprice. Writing
 * product_prices directly from this screen would silently skip that.
 *
 * Cost has no equivalent history table, so it is logged to the activity log
 * with its before and after — the same trail the product editor leaves.
 *
 * ── WHAT THIS WILL NOT WRITE ──────────────────────────────────────────
 * `average_cost`. It is a consequence of what was actually bought, and
 * updateProduct refuses it for the same reason: a screen that overwrote it
 * would falsify stock valuation. Only last_cost is a figure a person states.
 *
 * Refusals are per row and non-fatal, following the bulk-edit contract used
 * everywhere else in the app: a page of fifty must not fail because one product
 * was archived in another tab while the user was typing.
 */
export async function saveBulkPrices(
  siteId: number,
  structureId: number,
  edits: readonly BulkPriceEdit[],
  actor: { userId: number; userName: string },
): Promise<BulkPricingSaveResult> {
  const skipped: { id: number; reason: string }[] = []

  // Last edit wins if the same product somehow arrives twice.
  const byProduct = new Map<number, BulkPriceEdit>()
  for (const e of edits) {
    if (e.priceIncl !== undefined && (!Number.isFinite(e.priceIncl) || e.priceIncl < 0)) {
      skipped.push({ id: e.productId, reason: 'Not a valid price.' })
      continue
    }
    if (e.lastCost !== undefined && (!Number.isFinite(e.lastCost) || e.lastCost < 0)) {
      skipped.push({ id: e.productId, reason: 'Not a valid cost.' })
      continue
    }
    const prev = byProduct.get(e.productId)
    byProduct.set(e.productId, prev ? { ...prev, ...e } : e)
  }

  if (byProduct.size === 0) return { updated: 0, skipped }

  const wantsPrice = [...byProduct.values()].some((e) => e.priceIncl !== undefined)
  if (wantsPrice) {
    const structure = await siteQueryOne<RowDataPacket & { id: number }>(
      siteId,
      'SELECT id FROM price_structures WHERE id = ? AND is_active = 1 LIMIT 1',
      [structureId],
    )
    if (!structure) {
      return {
        updated: 0,
        skipped: [...byProduct.keys()].map((id) => ({
          id,
          reason: 'That price type is no longer active.',
        })),
      }
    }
  }

  const ids = [...byProduct.keys()]
  const existing = await siteQuery<Row>(
    siteId,
    `SELECT id, has_variants, last_cost, purchase_vat_rate_id, selling_vat_rate_id
       FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const live = new Map(existing.map((r) => [Number(r.id), r]))

  /* A tax rate id arrives from a browser, so it is checked against the rates
     that actually exist rather than trusted into a foreign key. */
  const validRates = await siteQuery<Row>(
    siteId,
    'SELECT id, vat_type FROM vat_rates WHERE is_active = 1',
  )
  const purchaseRateIds = new Set(
    validRates.filter((r) => r.vat_type === 'purchase').map((r) => Number(r.id)),
  )
  const sellingRateIds = new Set(
    validRates.filter((r) => r.vat_type === 'sales').map((r) => Number(r.id)),
  )

  const priceRows: { productId: number; priceStructureId: number; priceIncl: number }[] = []
  const productWrites: {
    id: number
    edit: BulkPriceEdit
    before: { lastCost: number; purchaseVatRateId: number | null; sellingVatRateId: number | null }
  }[] = []

  for (const [productId, edit] of byProduct) {
    const row = live.get(productId)
    if (!row) {
      skipped.push({ id: productId, reason: 'No longer exists.' })
      continue
    }
    // A parent's price is meaningless: its children carry the prices.
    if (row.has_variants) {
      skipped.push({ id: productId, reason: 'Has variants — price its options instead.' })
      continue
    }
    if (edit.purchaseVatRateId != null && !purchaseRateIds.has(edit.purchaseVatRateId)) {
      skipped.push({ id: productId, reason: 'That purchase tax rate is not available.' })
      continue
    }
    if (edit.sellingVatRateId != null && !sellingRateIds.has(edit.sellingVatRateId)) {
      skipped.push({ id: productId, reason: 'That selling tax rate is not available.' })
      continue
    }

    if (edit.priceIncl !== undefined) {
      priceRows.push({ productId, priceStructureId: structureId, priceIncl: edit.priceIncl })
    }
    if (
      edit.lastCost !== undefined ||
      edit.purchaseVatRateId !== undefined ||
      edit.sellingVatRateId !== undefined
    ) {
      productWrites.push({
        id: productId,
        edit,
        before: {
          lastCost: toNum(row.last_cost),
          purchaseVatRateId:
            row.purchase_vat_rate_id === null ? null : Number(row.purchase_vat_rate_id),
          sellingVatRateId:
            row.selling_vat_rate_id === null ? null : Number(row.selling_vat_rate_id),
        },
      })
    }
  }

  if (priceRows.length === 0 && productWrites.length === 0) {
    return { updated: 0, skipped }
  }

  await siteTransaction(siteId, async (tx) => {
    if (priceRows.length > 0) {
      await writePriceRows(tx, priceRows, { source: 'grid', userName: actor.userName })
    }

    for (const w of productWrites) {
      const sets: string[] = []
      const params: unknown[] = []
      const changes: Record<string, { from: unknown; to: unknown }> = {}

      if (w.edit.lastCost !== undefined && Math.abs(w.before.lastCost - w.edit.lastCost) > 0.00005) {
        sets.push('last_cost = ?')
        params.push(w.edit.lastCost.toFixed(4))
        changes.lastCost = { from: w.before.lastCost, to: w.edit.lastCost }
      }
      if (
        w.edit.purchaseVatRateId !== undefined &&
        w.edit.purchaseVatRateId !== w.before.purchaseVatRateId
      ) {
        sets.push('purchase_vat_rate_id = ?')
        params.push(w.edit.purchaseVatRateId)
        changes.purchaseVatRateId = {
          from: w.before.purchaseVatRateId,
          to: w.edit.purchaseVatRateId,
        }
      }
      if (
        w.edit.sellingVatRateId !== undefined &&
        w.edit.sellingVatRateId !== w.before.sellingVatRateId
      ) {
        sets.push('selling_vat_rate_id = ?')
        params.push(w.edit.sellingVatRateId)
        changes.sellingVatRateId = {
          from: w.before.sellingVatRateId,
          to: w.edit.sellingVatRateId,
        }
      }

      if (sets.length === 0) continue

      // last_edit_date, like the product form: this IS an edit a person made,
      // as distinct from updated_at which a stock movement also touches.
      await tx.execute(
        `UPDATE products SET ${sets.join(', ')}, last_edit_date = NOW() WHERE id = ?`,
        [...params, w.id] as never,
      )
      await logActivityTx(tx, actor, {
        entity: 'product',
        entityId: w.id,
        action: 'cost.bulk_edit',
        detail: 'Changed on the bulk pricing grid',
        changes,
      })
    }
  })

  // A product counts once however many of its figures moved.
  const touched = new Set<number>([
    ...priceRows.map((r) => r.productId),
    ...productWrites.map((w) => w.id),
  ])
  return { updated: touched.size, skipped }
}

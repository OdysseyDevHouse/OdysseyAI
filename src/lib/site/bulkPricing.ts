import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { effectiveCost, type CostBasis } from '../pricing'
import { writePriceRows } from './reprice'
import { getCostBasis } from './lookups'

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
  departmentName: string | null
}

export type BulkPricingOptions = {
  /** The price structure being edited. Every row's price is read for this one. */
  structureId: number
  search?: string
  departmentIds?: number[]
  brandId?: number
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
  if (opts.brandId) {
    where.push('p.brand_id = ?')
    params.push(opts.brandId)
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
            d.name AS department_name,
            COALESCE(v.rate, 0) AS selling_vat,
            (SELECT pp.selling_price_incl FROM product_prices pp
              WHERE pp.product_id = p.id AND pp.price_structure_id = ?) AS selling_incl
       FROM products p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN vat_rates v   ON v.id = p.selling_vat_rate_id
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
      departmentName: r.department_name === null ? null : String(r.department_name),
    }
  })

  return { items, total, costBasis: basis }
}

export type BulkPriceEdit = { productId: number; priceIncl: number }

export type BulkPricingSaveResult = {
  updated: number
  skipped: { id: number; reason: string }[]
}

/**
 * Commits a screenful of edited prices.
 *
 * Writes through writePriceRows, which is the ONE definition of a price write:
 * it reads the before-picture inside the same transaction and records the
 * history rows, so a change made here shows up on the product's Price history
 * panel next to one made by the editor or a reprice. Writing product_prices
 * directly from this screen would silently skip that.
 *
 * Refusals are per row and non-fatal, following the bulk-edit contract used
 * everywhere else in the app: a page of fifty must not fail because one product
 * was archived in another tab while the user was typing.
 */
export async function saveBulkPrices(
  siteId: number,
  structureId: number,
  edits: readonly BulkPriceEdit[],
  userName: string,
): Promise<BulkPricingSaveResult> {
  const skipped: { id: number; reason: string }[] = []

  // Last edit wins if the same product somehow arrives twice.
  const byProduct = new Map<number, number>()
  for (const e of edits) {
    if (!Number.isFinite(e.priceIncl) || e.priceIncl < 0) {
      skipped.push({ id: e.productId, reason: 'Not a valid price.' })
      continue
    }
    byProduct.set(e.productId, e.priceIncl)
  }

  if (byProduct.size === 0) return { updated: 0, skipped }

  const structure = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM price_structures WHERE id = ? AND is_active = 1 LIMIT 1',
    [structureId],
  )
  if (!structure) {
    return {
      updated: 0,
      skipped: [...byProduct.keys()].map((id) => ({ id, reason: 'That price type is no longer active.' })),
    }
  }

  const ids = [...byProduct.keys()]
  const existing = await siteQuery<Row>(
    siteId,
    `SELECT id, has_variants FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const live = new Map(existing.map((r) => [Number(r.id), !!r.has_variants]))

  const rows: { productId: number; priceStructureId: number; priceIncl: number }[] = []
  for (const [productId, priceIncl] of byProduct) {
    const hasVariants = live.get(productId)
    if (hasVariants === undefined) {
      skipped.push({ id: productId, reason: 'No longer exists.' })
      continue
    }
    // A parent's price is meaningless: its children carry the prices.
    if (hasVariants) {
      skipped.push({ id: productId, reason: 'Has variants — price its options instead.' })
      continue
    }
    rows.push({ productId, priceStructureId: structureId, priceIncl })
  }

  if (rows.length === 0) return { updated: 0, skipped }

  await siteTransaction(siteId, async (tx) => {
    await writePriceRows(tx, rows, { source: 'grid', userName })
  })

  return { updated: rows.length, skipped }
}

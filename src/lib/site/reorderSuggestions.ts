import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { round, toNum } from '../decimals'
import { stockedReferSql } from './productComposition'

/**
 * What to order, and why.
 *
 * The screen that turns purchasing from data capture into a tool: instead of a
 * buyer walking the aisles with a clipboard, the system proposes quantities and
 * the buyer corrects them.
 *
 * ── A SUGGESTION IS A PROPOSAL, NEVER AN ORDER ───────────────────────────
 *
 * Nothing here writes anything. Every quantity stays editable on the way to a
 * draft PO, and every line shows its own reasoning — on hand, on order, sold in
 * the window, suggested. A buyer who cannot see WHY will not trust the number,
 * and a replenishment tool nobody trusts is worse than none: it gets used once,
 * produces one bad order, and is never opened again.
 *
 * ── THE ONE THING THAT MUST NOT BE FORGOTTEN ─────────────────────────────
 *
 * Every basis subtracts what is ALREADY ON ORDER. Without it, running the
 * suggestion twice orders everything twice — the first order has not arrived,
 * so stock is still low, so the second run proposes it all again. That is the
 * classic way an auto-replenishment feature loses a shop's trust in a week, and
 * it is why `onOrder` is computed for every basis rather than only the ones
 * that seem to need it.
 *
 * ── WHY LEVELS ARE PER LOCATION ──────────────────────────────────────────
 *
 * min_stock and max_stock live on product_location_stock, per 025/028: a
 * warehouse holding 500 and a shop floor holding 5 need different reorder
 * points, and one site-wide number could only ever be wrong for one of them. So
 * a suggestion is always AGAINST A LOCATION.
 */

type Row = RowDataPacket & Record<string, unknown>

/** How the quantity to order is arrived at. */
export type ReorderBasis =
  /** stock_on_hand < min_stock. Order up to max. The straightforward one. */
  | 'below_minimum'
  /** Everything under max, topped up regardless of the minimum. */
  | 'min_to_max'
  /** Units sold over a window, projected across lead time plus cover. */
  | 'velocity'

export type ReorderOptions = {
  /** Which pile is being replenished. Levels and stock are read against it. */
  locationId: number
  basis: ReorderBasis
  /** Narrow to one supplier's products, via their preferred flag. */
  supplierId?: number
  departmentId?: number
  /** velocity: how many days of history to measure demand over. */
  windowDays?: number
  /** velocity: days of stock to hold beyond the supplier's lead time. */
  coverDays?: number
  /** Include products already at or above their target. Off by default. */
  includeSufficient?: boolean
  limit?: number
}

export type ReorderSuggestion = {
  productId: number
  code: string
  description: string
  productType: string
  departmentId: number | null
  departmentName: string | null
  /** In THIS location, not site-wide. */
  stockOnHand: number
  minStock: number
  maxStock: number
  /** Outstanding on issued purchase orders. Already subtracted. */
  onOrder: number
  /** velocity: units sold over the window, as a positive number. */
  soldInWindow: number
  /** velocity: units per day, from the window. */
  dailyDemand: number
  /** What the basis says should be on the shelf. */
  target: number
  /** Before rounding to a pack. Can be zero. */
  rawSuggested: number
  /** What to order, rounded up to the supplier's pack size. */
  suggested: number
  packSize: number
  /** Preferred supplier for this product, where one is marked. */
  supplierId: number | null
  supplierName: string | null
  supplierCode: string | null
  /** Last cost from that supplier, else the product's own last cost. */
  unitCostExcl: number
  leadTimeDays: number
}

/**
 * Products that hold stock.
 *
 * A service has no quantity to run out of and a recipe is assembled from its
 * ingredients rather than bought — proposing an order for either is noise in a
 * list whose whole value is that every row deserves attention. Variant PARENTS
 * are excluded for the same reason recordMovement refuses them: they hold no
 * stock of their own.
 *
 * A refer product is missing here for the same reason, with ONE exception:
 * under the normal method the pack is what the buyer actually orders — nobody
 * orders single bottles from a brewery, they order cases. stockedReferSql()
 * adds those back. See 103_refer_methods.sql.
 */
const STOCKED_TYPES = ['normal', 'returnable', 'serial', 'calcqty'] as const

/**
 * What to order, per the chosen basis.
 *
 * One query, not one per product: a 5,000-line catalogue would otherwise open
 * 5,000 round trips and take a minute to answer a question the buyer asked
 * casually.
 */
export async function reorderSuggestions(
  siteId: number,
  opts: ReorderOptions,
): Promise<ReorderSuggestion[]> {
  const windowDays = Math.min(Math.max(opts.windowDays ?? 30, 1), 730)
  const coverDays = Math.min(Math.max(opts.coverDays ?? 14, 0), 365)
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000)

  // IN THE ORDER THE PLACEHOLDERS APPEAR IN THE SQL BELOW, which is: the
  // demand window, the location the movements are counted in, then the
  // location the stock row joins on. Getting this order wrong does not throw —
  // it silently measures demand over a window of `locationId` days and counts
  // sales in location `windowDays`, which is how the first version of this
  // returned zero demand for every product.
  const params: unknown[] = [windowDays, opts.locationId, opts.locationId]
  const where: string[] = [
    'p.is_archived = 0',
    'p.has_variants = 0',
    `(p.product_type IN (${STOCKED_TYPES.map(() => '?').join(',')}) OR ${stockedReferSql('p')})`,
  ]
  params.push(...STOCKED_TYPES)

  if (opts.departmentId) {
    where.push('p.department_id = ?')
    params.push(opts.departmentId)
  }
  if (opts.supplierId) {
    // Their products: whatever is linked to them, preferred or not. A buyer
    // raising an order on one supplier wants everything that supplier can send.
    where.push('ps.supplier_id = ?')
    params.push(opts.supplierId)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.product_type, p.department_id, p.last_cost,
            d.name AS department_name,
            COALESCE(pls.stock_on_hand, 0) AS stock_on_hand,
            COALESCE(pls.min_stock, 0)     AS min_stock,
            COALESCE(pls.max_stock, 0)     AS max_stock,

            -- Sold over the window, as a POSITIVE number. Sale movements are
            -- negative deltas, and returns are positive ones of the same type
            -- family — netting them is right: a unit sold and brought back was
            -- not really demand.
            COALESCE((
              SELECT -SUM(m.qty_change)
                FROM stock_movements m
               WHERE m.product_id = p.id
                 AND m.movement_type IN ('sale','sale_return')
                 AND m.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                 AND (m.location_id = ? OR m.location_id IS NULL)
            ), 0) AS sold_in_window,

            -- ALREADY ON ORDER. The figure that stops a second run ordering
            -- everything a second time. Only issued orders that are still
            -- open, and only the part that has not arrived.
            COALESCE((
              SELECT SUM(GREATEST(ol.qty_ordered - ol.qty_received, 0))
                FROM purchase_document_lines ol
                JOIN purchase_documents od     ON od.id = ol.document_id
                LEFT JOIN purchase_order_details oo ON oo.document_id = od.id
               WHERE ol.product_id = p.id
                 AND od.doc_type = 'purchase_order'
                 AND od.status = 'issued'
                 AND COALESCE(oo.fulfilment_status, 'open') IN ('open','part_received')
            ), 0) AS on_order,

            ps.supplier_id, ps.supplier_code, ps.pack_size, ps.last_cost AS supplier_cost,
            s.name AS supplier_name, s.lead_time_days
       FROM products p
       LEFT JOIN product_location_stock pls
              ON pls.product_id = p.id AND pls.location_id = ?
       LEFT JOIN departments d ON d.id = p.department_id
       -- The preferred supplier, or any one of them when none is marked. A
       -- correlated pick rather than a join, so a product available from three
       -- suppliers still produces exactly one row.
       LEFT JOIN product_suppliers ps
              ON ps.product_id = p.id
             AND ps.supplier_id = (
                   SELECT x.supplier_id FROM product_suppliers x
                    WHERE x.product_id = p.id
                    ORDER BY x.is_preferred DESC, x.supplier_id
                    LIMIT 1
                 )
       LEFT JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.description
      LIMIT ${limit}`,
    params,
  )

  const out: ReorderSuggestion[] = []

  for (const r of rows) {
    const stockOnHand = toNum(r.stock_on_hand)
    const minStock = toNum(r.min_stock)
    const maxStock = toNum(r.max_stock)
    const onOrder = toNum(r.on_order)
    const soldInWindow = Math.max(toNum(r.sold_in_window), 0)
    const leadTimeDays = Number(r.lead_time_days ?? 0)
    const packSize = Math.max(toNum(r.pack_size) || 1, 0.001)

    const dailyDemand = round(soldInWindow / windowDays, 4)

    // What the basis says SHOULD be on the shelf.
    let target = 0
    switch (opts.basis) {
      case 'below_minimum':
        // Only acts once stock has actually fallen through the floor. Topping
        // up to max rather than to min: ordering exactly to the minimum means
        // the next sale drops below it again and the product reappears on
        // tomorrow's list.
        target = stockOnHand + onOrder < minStock ? Math.max(maxStock, minStock) : 0
        break

      case 'min_to_max':
        target = Math.max(maxStock, minStock)
        break

      case 'velocity':
        // Enough to cover the wait for the order PLUS a buffer. Falls back to
        // the minimum where a product has no sales history — a new line that
        // has never sold still needs its shelf filled.
        target = round(dailyDemand * (leadTimeDays + coverDays), 3)
        if (target === 0 && minStock > 0) target = minStock
        break
    }

    // THE SUBTRACTION. What is coming counts as if it were here.
    const rawSuggested = round(Math.max(target - stockOnHand - onOrder, 0), 3)

    // Up to a whole pack: a supplier who ships in cases of 24 will not send 7.
    const suggested =
      rawSuggested === 0 ? 0 : round(Math.ceil(rawSuggested / packSize) * packSize, 3)

    if (suggested <= 0 && !opts.includeSufficient) continue

    out.push({
      productId: Number(r.id),
      code: String(r.code),
      description: String(r.description),
      productType: String(r.product_type),
      departmentId: r.department_id === null ? null : Number(r.department_id),
      departmentName: (r.department_name as string | null) ?? null,
      stockOnHand,
      minStock,
      maxStock,
      onOrder,
      soldInWindow,
      dailyDemand,
      target: round(target, 3),
      rawSuggested,
      suggested,
      packSize,
      supplierId: r.supplier_id === null || r.supplier_id === undefined ? null : Number(r.supplier_id),
      supplierName: (r.supplier_name as string | null) ?? null,
      supplierCode: (r.supplier_code as string | null) ?? null,
      // Their cost for it beats our own last cost: the order goes out at what
      // THEY charge, which may differ from what the last delivery happened to.
      unitCostExcl: toNum(r.supplier_cost) > 0 ? toNum(r.supplier_cost) : toNum(r.last_cost),
      leadTimeDays,
    })
  }

  return out
}

/**
 * Suggestions gathered per supplier, which is how an order is actually raised.
 *
 * A buyer does not order "these forty products" — they send one order to each
 * supplier. Products with no supplier linked come back under a null key so they
 * are visible rather than silently dropped: "nobody supplies this" is
 * information the buyer needs, not a reason to hide the row.
 */
export type SupplierGroup = {
  supplierId: number | null
  supplierName: string | null
  leadTimeDays: number
  /** Excluding VAT, at the suggested quantities. */
  totalExcl: number
  /** What they will not deliver below. Zero when unknown. */
  minimumOrder: number
  lines: ReorderSuggestion[]
}

export async function reorderBySupplier(
  siteId: number,
  opts: ReorderOptions,
): Promise<SupplierGroup[]> {
  const suggestions = await reorderSuggestions(siteId, opts)

  const groups = new Map<number | null, SupplierGroup>()
  for (const s of suggestions) {
    const key = s.supplierId
    const group = groups.get(key)
    if (group) {
      group.lines.push(s)
      group.totalExcl = round(group.totalExcl + s.suggested * s.unitCostExcl, 2)
    } else {
      groups.set(key, {
        supplierId: key,
        supplierName: s.supplierName,
        leadTimeDays: s.leadTimeDays,
        totalExcl: round(s.suggested * s.unitCostExcl, 2),
        minimumOrder: 0,
        lines: [s],
      })
    }
  }

  // Their delivery floor, for the warning on the screen. One query for the
  // whole set rather than one per group.
  const ids = [...groups.keys()].filter((id): id is number => id !== null)
  if (ids.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, minimum_order FROM suppliers WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    )
    for (const r of rows) {
      const group = groups.get(Number(r.id))
      if (group) group.minimumOrder = toNum(r.minimum_order)
    }
  }

  // Biggest order first, and the unsupplied rows last — they need a decision
  // rather than a click, so they should not sit between two things to send.
  return [...groups.values()].sort((a, b) => {
    if (a.supplierId === null) return 1
    if (b.supplierId === null) return -1
    return b.totalExcl - a.totalExcl
  })
}

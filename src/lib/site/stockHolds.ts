import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteQuery, siteExecute } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'

/**
 * What an online order has spoken for, before anyone in the shop agreed to it.
 *
 * ── A HOLD IS NOT A STOCK MOVEMENT ───────────────────────────────────────
 *
 * Nothing here writes to `products.stock_on_hand` or to `stock_movements`, so
 * `Σ qty_change = stock_on_hand` still holds and the reconciliation report keeps
 * working. A held item is still owned by the shop and still on the shelf; what
 * a hold changes is only what the STOREFRONT advertises.
 *
 * That is the same claim an open sales order or a lay-by already makes — see
 * reservedQty in stockMovements.ts, which this joins as a third source.
 *
 * ── LIVE IS A PREDICATE, NOT A STATE ─────────────────────────────────────
 *
 * A hold counts when `released_at IS NULL AND expires_at > NOW()`. There is no
 * status column to keep in step, and no sweep that has to run for a hold to
 * stop counting. The sweep below only tidies rows.
 *
 * This is deliberate. A crashed cron, an unset secret or a host that never
 * scheduled the job would otherwise leak holds forever and hide sellable stock
 * with no symptom but quiet lost sales. Written this way the worst a dead sweep
 * causes is old rows nobody reads.
 */

type Row = Record<string, unknown>

/** The predicate, in one place, so every query agrees on what "live" means. */
export const LIVE_HOLD = 'h.released_at IS NULL AND h.expires_at > NOW()'

export type StockHold = {
  id: number
  orderId: number
  productId: number
  qty: number
  expiresAt: Date | null
  releasedAt: Date | null
  releaseNote: string
}

function mapHold(r: Row): StockHold {
  return {
    id: Number(r.id),
    orderId: Number(r.order_id),
    productId: Number(r.product_id),
    qty: toNum(r.qty),
    expiresAt: asDate(r.expires_at),
    releasedAt: asDate(r.released_at),
    releaseNote: String(r.release_note ?? ''),
  }
}

function asDate(value: unknown): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Hold the stock an order has just claimed.
 *
 * Takes the caller's OPEN transaction: a hold written outside the transaction
 * that created the order could survive a rollback and keep goods off the shelf
 * for an order that does not exist.
 *
 * `holdMinutes` of 0 means the shop has switched holding off, and nothing is
 * written at all — that is the pre-076 behaviour and a legitimate choice for a
 * shop with deep stock that would rather never refuse a shopper.
 */
export async function placeHolds(
  tx: PoolConnection,
  orderId: number,
  lines: { productId: number; qty: number }[],
  holdMinutes: number,
): Promise<number> {
  if (holdMinutes <= 0) return 0

  // Clamped: a settings row with an absurd value must not park stock for a
  // month, and a negative one is already excluded above.
  const minutes = Math.min(Math.max(Math.round(holdMinutes), 1), 60 * 24 * 7)

  let placed = 0
  for (const line of lines) {
    const productId = Number(line.productId)
    const qty = Number(line.qty)
    if (!Number.isInteger(productId) || productId <= 0 || !(qty > 0)) continue

    await tx.execute(
      `INSERT INTO online_stock_holds (order_id, product_id, qty, expires_at)
       VALUES (?,?,?, NOW() + INTERVAL ? MINUTE)`,
      [orderId, productId, qty.toFixed(3), minutes] as never,
    )
    placed++
  }
  return placed
}

/**
 * Let go of everything an order was holding.
 *
 * Called on accept (the goods are a real sale now and stock actually moves),
 * decline and cancel. Idempotent: a second call marks nothing, because the
 * WHERE already excludes released rows.
 *
 * Takes an optional transaction so the release can ride along with whatever
 * made it true — releasing outside the transaction that accepted an order
 * would free the stock even if the acceptance then rolled back.
 */
export async function releaseHolds(
  siteId: number,
  orderId: number,
  note: 'accepted' | 'declined' | 'cancelled',
  tx?: PoolConnection,
): Promise<void> {
  const sql = `UPDATE online_stock_holds
                  SET released_at = NOW(), release_note = ?
                WHERE order_id = ? AND released_at IS NULL`
  const params = [note, orderId]
  if (tx) {
    await tx.execute(sql, params as never)
    return
  }
  await siteExecute(siteId, sql, params)
}

/**
 * Tidy holds that have already stopped counting.
 *
 * Cosmetic, deliberately. `expires_at` is what makes a hold stop applying, and
 * every read enforces it — this only stamps the rows so the orders queue can
 * say "expired" rather than showing a hold that silently does nothing.
 *
 * Safe to call at any interval, or never.
 */
export async function sweepExpiredHolds(siteId: number): Promise<number> {
  const result = await siteExecute(
    siteId,
    `UPDATE online_stock_holds
        SET released_at = expires_at, release_note = 'expired'
      WHERE released_at IS NULL AND expires_at <= NOW()`,
  ).catch(() => null)
  return result?.affectedRows ?? 0
}

/**
 * How much of each product is held right now.
 *
 * Products with nothing held are absent from the map — the caller reads a
 * missing key as zero, matching reservedQtyFor's contract.
 */
export async function heldQtyFor(
  siteId: number,
  productIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()

  const placeholders = ids.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT h.product_id, SUM(h.qty) AS held
       FROM online_stock_holds h
      WHERE h.product_id IN (${placeholders}) AND ${LIVE_HOLD}
      GROUP BY h.product_id`,
    ids,
  ).catch(() => [])

  return new Map(rows.map((r) => [Number(r.product_id), toNum(r.held)]))
}

/** Every live hold on one order, for the queue to show what it is keeping. */
export async function holdsForOrder(siteId: number, orderId: number): Promise<StockHold[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT h.* FROM online_stock_holds h WHERE h.order_id = ? ORDER BY h.id`,
    [orderId],
  ).catch(() => [])
  return rows.map(mapHold)
}

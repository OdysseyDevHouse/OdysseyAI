import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { toNum } from '../decimals'
import { duePricesFor } from './priceSchedules'

/**
 * What a label run prints — the data half, ephemeral by design.
 *
 * No labels table: a run is regenerated from its SOURCE document server-side,
 * which also means reprinting tomorrow reflects tomorrow's truth. Three
 * sources: everything a GRV received, everything a price schedule changes,
 * and a hand-picked list.
 */

type Row = RowDataPacket & Record<string, unknown>

export type LabelItem = {
  productId: number
  code: string
  description: string
  /** The PRIMARY barcode — a shelf edge carries the code the shelf scans. */
  barcode: string | null
  priceIncl: number
  /** The price it replaces, when the source knows one (a schedule's old). */
  wasPriceIncl: number | null
  /** How many of this label the A4 sheet prints. */
  qty: number
}

export type LabelSource =
  | { kind: 'grv'; documentId: number }
  | { kind: 'schedule'; scheduleId: number }
  | { kind: 'products'; ids: number[]; qty?: Record<number, number> }

const CAP = 500

export async function labelItems(
  siteId: number,
  source: LabelSource,
  priceStructureId: number | null,
): Promise<LabelItem[]> {
  if (source.kind === 'schedule') {
    /*
     * THE point of printing from a schedule: labels for six o'clock printed at
     * five must show the six o'clock price. The line's new price is used for
     * its own structure; `wasPriceIncl` carries the old for the talker's
     * strike-through.
     */
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT DISTINCT l.product_id, p.code, p.description, p.barcode,
              l.new_price_incl, l.old_price_incl
         FROM price_schedule_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.schedule_id = ?
          ${priceStructureId ? 'AND l.price_structure_id = ?' : ''}
        ORDER BY p.description
        LIMIT ${CAP}`,
      priceStructureId ? [source.scheduleId, priceStructureId] : [source.scheduleId],
    )
    return rows.map((r) => ({
      productId: Number(r.product_id),
      code: String(r.code),
      description: String(r.description),
      barcode: (r.barcode as string | null) ?? null,
      priceIncl: toNum(r.new_price_incl),
      wasPriceIncl: r.old_price_incl === null ? null : toNum(r.old_price_incl),
      qty: 1,
    }))
  }

  if (source.kind === 'grv') {
    // One label per product — a shelf edge is per product, not per unit.
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT DISTINCT l.product_id, p.code, p.description, p.barcode
         FROM purchase_document_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.document_id = ? AND l.product_id IS NOT NULL AND l.qty_received > 0
        ORDER BY p.description
        LIMIT ${CAP}`,
      [source.documentId],
    )
    return priceThrough(siteId, rows, priceStructureId)
  }

  const ids = [...new Set(source.ids)].slice(0, CAP)
  if (ids.length === 0) return []
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id AS product_id, p.code, p.description, p.barcode
       FROM products p WHERE p.id IN (${ids.map(() => '?').join(',')})
      ORDER BY p.description`,
    ids,
  )
  const items = await priceThrough(siteId, rows, priceStructureId)
  return items.map((item) => ({
    ...item,
    qty: Math.max(1, Math.trunc(source.qty?.[item.productId] ?? 1)),
  }))
}

/**
 * Prices through any DUE scheduled change first, then product_prices at the
 * chosen structure (default structure when null) — the same resolution the
 * till applies, so the shelf edge and the till agree.
 */
async function priceThrough(
  siteId: number,
  rows: Row[],
  priceStructureId: number | null,
): Promise<LabelItem[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => Number(r.product_id))

  const [prices, due] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT pp.product_id, pp.selling_price_incl
         FROM product_prices pp
        WHERE pp.product_id IN (${ids.map(() => '?').join(',')})
          AND pp.price_structure_id = ${
            priceStructureId
              ? '?'
              : '(SELECT id FROM price_structures WHERE is_default = 1 LIMIT 1)'
          }`,
      priceStructureId ? [...ids, priceStructureId] : ids,
    ),
    duePricesFor(siteId, priceStructureId, ids).catch(() => new Map<number, number>()),
  ])
  const priceBy = new Map(prices.map((p) => [Number(p.product_id), toNum(p.selling_price_incl)]))

  return rows.map((r) => {
    const id = Number(r.product_id)
    return {
      productId: id,
      code: String(r.code),
      description: String(r.description),
      barcode: (r.barcode as string | null) ?? null,
      priceIncl: due.get(id) ?? priceBy.get(id) ?? 0,
      wasPriceIncl: null,
      qty: 1,
    }
  })
}

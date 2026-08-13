import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { toNum } from '../decimals'

/**
 * Reading the price history (144).
 *
 * The writes live in reprice.ts — writePriceRows is the one definition of a
 * price write, and the history is its side effect. This file only answers the
 * product screen's question: what moved, when, through which door, by whom.
 */

export type PriceHistoryRow = {
  id: number
  priceStructureId: number
  structureName: string
  /** Null = the product had no price under this structure before. */
  oldPriceIncl: number | null
  /** Null = the price row was removed (a schedule revert of a first fill). */
  newPriceIncl: number | null
  source: string
  sourceDocId: number | null
  userName: string
  at: Date
}

export async function listPriceHistory(
  siteId: number,
  productId: number,
  limit = 50,
): Promise<PriceHistoryRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT h.id, h.price_structure_id, ps.name AS structure_name, h.old_price_incl, h.new_price_incl,
            h.source, h.source_doc_id, h.user_name, h.created_at
       FROM product_price_history h
       LEFT JOIN price_structures ps ON ps.id = h.price_structure_id
      WHERE h.product_id = ?
      ORDER BY h.id DESC
      LIMIT ${capped}`,
    [productId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    priceStructureId: Number(r.price_structure_id),
    structureName: String(r.structure_name ?? `Structure ${r.price_structure_id}`),
    oldPriceIncl: r.old_price_incl === null ? null : toNum(r.old_price_incl),
    newPriceIncl: r.new_price_incl === null ? null : toNum(r.new_price_incl),
    source: String(r.source),
    sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
    userName: String(r.user_name ?? ''),
    at: r.created_at as Date,
  }))
}

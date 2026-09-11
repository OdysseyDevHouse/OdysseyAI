import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { toNum } from '../decimals'

/**
 * Reading the price and cost history (144, 256).
 *
 * The writes live in reprice.ts — writePriceRows is the one definition of a
 * price write, writeCostHistory the one definition of a cost note, and the
 * history is their side effect. This file only answers the product screen's
 * question: what moved, when, through which door, by whom.
 *
 * ── WHY ONE READ AND NOT TWO ────────────────────────────────────────────────
 *
 * Cost and price share a table (see 256) because they share a QUESTION: "the
 * margin on this looks wrong — what moved, and which came first?" A supplier
 * putting a cost up on Monday and the shelf price that answered it on Tuesday
 * are one story, and the screen tells it by reading them in one order.
 */

export type PriceHistoryRow = {
  id: number
  /**
   * Which figure moved. 'price' is a shelf price under one price type; 'cost'
   * is what the product costs the shop.
   */
  kind: 'price' | 'cost'
  /**
   * Which cost column moved — 'last' (what was last paid) or 'average' (what
   * the stock on hand is worth). Null on a price row.
   */
  costColumn: 'last' | 'average' | null
  /** Null on a cost row: a cost belongs to the product, not to a price type. */
  priceStructureId: number | null
  /** The price type's name, or null on a cost row. */
  structureName: string | null
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
    `SELECT h.id, h.kind, h.cost_column, h.price_structure_id, ps.name AS structure_name,
            h.old_price_incl, h.new_price_incl,
            h.source, h.source_doc_id, h.user_name, h.created_at
       FROM product_price_history h
       LEFT JOIN price_structures ps ON ps.id = h.price_structure_id
      WHERE h.product_id = ?
      ORDER BY h.id DESC
      LIMIT ${capped}`,
    [productId],
  )
  return rows.map((r) => {
    /* Defaulted rather than asserted: 256 adds the column with a default of
       'price', but a site the migration has not reached yet still renders this
       panel, and every row it holds is a price. */
    const kind = String(r.kind ?? 'price') === 'cost' ? 'cost' : 'price'
    return {
      id: Number(r.id),
      kind,
      costColumn:
        r.cost_column === null || r.cost_column === undefined
          ? null
          : String(r.cost_column) === 'average'
            ? 'average'
            : 'last',
      priceStructureId: r.price_structure_id === null ? null : Number(r.price_structure_id),
      structureName: r.structure_name === null ? null : String(r.structure_name),
      oldPriceIncl: r.old_price_incl === null ? null : toNum(r.old_price_incl),
      newPriceIncl: r.new_price_incl === null ? null : toNum(r.new_price_incl),
      source: String(r.source),
      sourceDocId: r.source_doc_id === null ? null : Number(r.source_doc_id),
      userName: String(r.user_name ?? ''),
      at: r.created_at as Date,
    }
  })
}

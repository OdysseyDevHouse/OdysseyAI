import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, qty, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Negative stock — stock on hand below zero.
 *
 * Not a stock position but a bookkeeping wound: a delivery nobody captured, a
 * barcode ringing up the wrong product, or a pack-size setup error. Caught the
 * same day it is one correction; caught at stocktake it is a month of wrong
 * margins, wrong reorder suggestions and wrong valuations, all of which look
 * plausible.
 *
 * Read-only, and no knobs — "below zero" is not a threshold anybody tunes.
 */

export type NegativeStockItem = {
  productId: number
  code: string
  description: string
  onHand: number
  locationName: string | null
}

export type NegativeStockResult = {
  /** The worst offenders, capped at READ_LIMIT. */
  items: NegativeStockItem[]
  /** How many there ACTUALLY are — counted, never inferred from items.length. */
  total: number
}

type Row = RowDataPacket & Record<string, unknown>

export async function evaluateNegativeStock(siteId: number): Promise<NegativeStockResult> {
  // Per LOCATION, not the site-wide products.stock_on_hand roll-up: a shop with
  // -4 in the storeroom and +6 on the shelf has a real problem that a site-wide
  // +2 hides completely. The roll-up is the number the shop trades on; this is
  // the number that says where it went wrong.
  const where = `pls.stock_on_hand < 0 AND p.is_archived = 0 AND l.is_active = 1`

  // Counted separately from the rows that get read. A shop fresh off a bad
  // stocktake can have thousands negative, and reading them all to display a
  // hundred is waste — but the headline must still say how many there really
  // are, so the cap never quietly becomes a smaller, wrong number.
  const countRows = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n
       FROM product_location_stock pls
       JOIN products p        ON p.id = pls.product_id
       JOIN stock_locations l ON l.id = pls.location_id
      WHERE ${where}`,
  )
  const total = Number(countRows[0]?.n) || 0

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, pls.stock_on_hand, l.name AS location_name
       FROM product_location_stock pls
       JOIN products p        ON p.id = pls.product_id
       JOIN stock_locations l ON l.id = pls.location_id
      WHERE ${where}
      ORDER BY pls.stock_on_hand ASC
      LIMIT ${READ_LIMIT}`,
  )

  return {
    total,
    items: rows.map((r) => ({
      productId: Number(r.id),
      code: String(r.code ?? ''),
      description: String(r.description ?? '') || '(no description)',
      onHand: Number(r.stock_on_hand) || 0,
      locationName: r.location_name ? String(r.location_name) : null,
    })),
  }
}

export function negativeStockMessage(
  rule: AlertRule,
  result: NegativeStockResult,
): AlertMessage {
  // The headline is the TRUE count; the lists below are only what was read.
  const n = result.total
  const shown = result.items.slice(0, TEXT_LINES)

  const lines = shown.map(
    (i) =>
      `${i.description} (${i.code})${i.locationName ? ` at ${i.locationName}` : ''}: ${qty(i.onHand)} on hand`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'negative_stock',
    title: `Negative stock: ${count(n, 'product')} below zero`,
    summary:
      'Usually a delivery nobody captured or a barcode on the wrong product — worth fixing before the numbers spread into reports.',
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'product')} with stock on hand below zero.`,
      columns: [
        { header: 'Product' },
        { header: 'Code' },
        { header: 'Location' },
        { header: 'On hand', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [i.description, i.code, i.locationName ?? '', qty(i.onHand)]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more, worst first.`] : []),
        'Capture the missing delivery, or adjust the count to what is really on the shelf.',
      ],
    }),
    href: '/products',
  }
}

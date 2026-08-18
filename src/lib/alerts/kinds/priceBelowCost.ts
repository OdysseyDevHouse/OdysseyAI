import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Selling below cost, or under the margin the shop set.
 *
 * The classic way to lose money while looking busy: a cost goes up on a
 * delivery, nobody re-prices the shelf, and every sale of that line from then
 * on is a small donation. Nothing about the till or the reports says so — the
 * sale rings up perfectly.
 *
 * ── MARGIN IS COMPUTED ON THE EXCLUSIVE PRICE ────────────────────────────
 *
 * The report builder's "Margin %" field uses the VAT-INCLUSIVE price, and this
 * check deliberately does not. On a 15% VAT line, margin against the inclusive
 * price reads about 13 points better than the business actually earns, because
 * the VAT is the state's money and was never margin. For a column somebody
 * eyeballs beside a price that is a defensible shorthand; for a threshold that
 * decides whether to interrupt an owner it would misfire in the one direction
 * that matters — quietly staying silent on lines that are genuinely underwater.
 *
 * The comparison is against AVERAGE cost, not last cost: last cost makes one
 * unusual delivery look like a pricing emergency across the whole shelf.
 */

export type PriceBelowCostItem = {
  productId: number
  code: string
  description: string
  /** VAT-exclusive, which is what the margin is measured against. */
  priceExcl: number
  cost: number
  gpPct: number
}

export type PriceBelowCostResult = {
  items: PriceBelowCostItem[]
  total: number
  /** The threshold that was applied, for the message. */
  minGpPct: number
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * The default price structure's price, converted to exclusive with the
 * product's own selling VAT rate.
 *
 * A product with no price row is NOT reported: "no price" is a different
 * problem with a different fix (and its own alert kind), and folding it in here
 * would bury the lines that really are underwater in a list of unfinished ones.
 */
const FROM = `
  FROM products p
  JOIN product_prices pp   ON pp.product_id = p.id
  JOIN price_structures ps ON ps.id = pp.price_structure_id AND ps.is_default = 1
  LEFT JOIN vat_rates v    ON v.id = p.selling_vat_rate_id
`

const PRICE_EXCL = `(pp.selling_price_incl / NULLIF(1 + COALESCE(v.rate, 0) / 100, 0))`

export async function evaluatePriceBelowCost(
  siteId: number,
  rule: AlertRule,
): Promise<PriceBelowCostResult> {
  const minGpPct = rule.config.minGpPct

  // A product with no cost yet is not underwater — it is uncosted, and
  // reporting it as a margin failure would cry wolf on every new line.
  const where = `
    p.is_archived = 0
    AND p.has_variants = 0
    AND COALESCE(p.average_cost, 0) > 0
    AND ${PRICE_EXCL} > 0
    AND ((${PRICE_EXCL} - p.average_cost) / ${PRICE_EXCL}) * 100 < ?
  `

  const countRows = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n ${FROM} WHERE ${where}`,
    [minGpPct],
  )
  const total = Number(countRows[0]?.n) || 0

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.average_cost,
            ${PRICE_EXCL} AS price_excl,
            ((${PRICE_EXCL} - p.average_cost) / ${PRICE_EXCL}) * 100 AS gp_pct
       ${FROM}
      WHERE ${where}
      ORDER BY gp_pct ASC
      LIMIT ${READ_LIMIT}`,
    [minGpPct],
  )

  return {
    total,
    minGpPct,
    items: rows.map((r) => ({
      productId: Number(r.id),
      code: String(r.code ?? ''),
      description: String(r.description ?? '') || '(no description)',
      priceExcl: Number(r.price_excl) || 0,
      cost: Number(r.average_cost) || 0,
      gpPct: Number(r.gp_pct) || 0,
    })),
  }
}

export function priceBelowCostMessage(
  rule: AlertRule,
  result: PriceBelowCostResult,
): AlertMessage {
  const n = result.total
  const belowCost = result.items.filter((i) => i.gpPct < 0).length

  // Two different problems wear one threshold: at or under zero the shop pays
  // customers to shop, above it the line simply earns too little. The headline
  // says which, because they get fixed with different urgency.
  const title =
    result.minGpPct <= 0
      ? `Selling below cost: ${count(n, 'product')}`
      : `Thin margins: ${count(n, 'product')} under ${result.minGpPct}%`

  const shown = result.items.slice(0, TEXT_LINES)
  const lines = shown.map(
    (i) =>
      `${i.description} (${i.code}): ${rands(i.priceExcl)} excl. vs cost ${rands(i.cost)} — ${i.gpPct.toFixed(1)}%`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'price_below_cost',
    title,
    summary:
      belowCost > 0
        ? `${count(belowCost, 'line')} sells for less than it cost — usually a cost increase nobody re-priced.`
        : 'Worth re-pricing, or checking the cost is right.',
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'product')} priced under ${
        result.minGpPct <= 0 ? 'cost' : `${result.minGpPct}% margin`
      }.`,
      columns: [
        { header: 'Product' },
        { header: 'Code' },
        { header: 'Price excl.', align: 'right' },
        { header: 'Average cost', align: 'right' },
        { header: 'Margin', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.description,
          i.code,
          rands(i.priceExcl),
          rands(i.cost),
          `${i.gpPct.toFixed(1)}%`,
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more, worst first.`] : []),
        'Margin is measured against the price excluding VAT, and against average cost.',
      ],
    }),
    href: '/products',
  }
}

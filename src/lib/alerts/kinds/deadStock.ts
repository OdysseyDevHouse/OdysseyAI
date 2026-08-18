import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, qty, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Dead stock — money sitting on a shelf.
 *
 * Stock that has not sold in months is not neutral: it was paid for, it is
 * insured, it occupies the space a moving line would occupy, and it will
 * eventually be marked down or written off. The whole value of finding it is
 * finding it EARLY, while a markdown still recovers most of the cost.
 *
 * ── NEVER-SOLD COUNTS AS DEAD ────────────────────────────────────────────
 *
 * A product with stock and no sale at all is the worst case, not an
 * exclusion — but only once it has had a fair chance to sell. Treating a
 * NULL last_sold_date as "sold infinitely long ago" would flag every line
 * received this morning; measuring from when the product was created instead
 * gives a new line the same window as an old one.
 */

export type DeadStockItem = {
  productId: number
  code: string
  description: string
  onHand: number
  value: number
  daysQuiet: number
  neverSold: boolean
}

export type DeadStockResult = {
  items: DeadStockItem[]
  total: number
  /** The money tied up in what was READ, for the summary line. */
  valueShown: number
  /** The total tied up across everything found — the number worth acting on. */
  valueTotal: number
  days: number
  minValue: number
}

type Row = RowDataPacket & Record<string, unknown>

export async function evaluateDeadStock(
  siteId: number,
  rule: AlertRule,
): Promise<DeadStockResult> {
  const days = rule.config.days
  const minValue = rule.config.minValue

  // COALESCE(last_sold_date, created_at) is the "fair chance" rule above: a
  // never-sold product is measured from when it arrived, so the window means
  // the same thing for every line.
  const quietSince = `COALESCE(p.last_sold_date, p.created_at)`
  const value = `(p.stock_on_hand * COALESCE(p.average_cost, 0))`

  const where = `
    p.is_archived = 0
    AND p.has_variants = 0
    AND p.stock_on_hand > 0
    AND ${quietSince} < DATE_SUB(NOW(), INTERVAL ? DAY)
    AND ${value} >= ?
  `
  const params = [days, minValue]

  // Counted and TOTALLED separately from the rows that get read: the money
  // tied up is the number that makes somebody act, and it must be the whole
  // figure — not the sum of the first 500 rows, which would understate it in
  // exactly the shops that need it most.
  const totals = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n, COALESCE(SUM(${value}), 0) AS v FROM products p WHERE ${where}`,
    params,
  )
  const total = Number(totals[0]?.n) || 0
  const valueTotal = Number(totals[0]?.v) || 0

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.stock_on_hand, p.last_sold_date,
            ${value} AS value,
            DATEDIFF(NOW(), ${quietSince}) AS days_quiet
       FROM products p
      WHERE ${where}
      ORDER BY value DESC
      LIMIT ${READ_LIMIT}`,
    params,
  )

  const items = rows.map((r) => ({
    productId: Number(r.id),
    code: String(r.code ?? ''),
    description: String(r.description ?? '') || '(no description)',
    onHand: Number(r.stock_on_hand) || 0,
    value: Number(r.value) || 0,
    daysQuiet: Number(r.days_quiet) || 0,
    neverSold: r.last_sold_date === null,
  }))

  return {
    total,
    valueTotal,
    valueShown: items.reduce((sum, i) => sum + i.value, 0),
    items,
    days,
    minValue,
  }
}

export function deadStockMessage(rule: AlertRule, result: DeadStockResult): AlertMessage {
  const n = result.total
  const shown = result.items.slice(0, TEXT_LINES)

  const lines = shown.map(
    (i) =>
      `${i.description} (${i.code}): ${qty(i.onHand)} on hand, ${rands(i.value)}${
        i.neverSold ? ' — never sold' : ` — quiet ${i.daysQuiet} days`
      }`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'dead_stock',
    title: `Dead stock: ${count(n, 'product')} holding ${rands(result.valueTotal)}`,
    // The money, not the count, is what makes this worth reading — 400 dead
    // lines worth R900 is housekeeping; 12 worth R80,000 is a decision.
    summary: `Nothing sold in ${result.days} days. ${rands(result.valueTotal)} is tied up in stock that is not moving.`,
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'product')} with stock that has not sold in ${result.days} days — ${rands(result.valueTotal)} at cost.`,
      columns: [
        { header: 'Product' },
        { header: 'Code' },
        { header: 'On hand', align: 'right' },
        { header: 'Value', align: 'right' },
        { header: 'Quiet for', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.description,
          i.code,
          qty(i.onHand),
          rands(i.value),
          i.neverSold ? 'never sold' : `${i.daysQuiet} days`,
        ]),
      notes: [
        ...(n > EMAIL_ROWS
          ? [`…and ${n - EMAIL_ROWS} more, most valuable first (${rands(result.valueShown)} shown).`]
          : []),
        result.minValue > 0
          ? `Anything holding less than ${rands(result.minValue)} was left out.`
          : 'A never-sold line is measured from the day it was created, so new stock is not flagged early.',
      ],
    }),
    href: '/products',
  }
}

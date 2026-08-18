import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Drawers that did not balance.
 *
 * ── WHY IT LOOKS BACK A DAY, NOT AT "TODAY" ──────────────────────────────
 *
 * The window is the closed shifts since the previous run of this rule — in
 * practice yesterday's, for a daily rule that fires each morning. A shift that
 * closed an hour ago on a till still trading tonight is not a finished story,
 * and a rule that reported it would report it again tomorrow.
 *
 * ── SHORTAGES AND OVERAGES ARE NOT THE SAME EVENT ────────────────────────
 *
 * Short means money is missing. Over means the count or the capture is wrong —
 * which sounds harmless and is not: a drawer that is over by exactly the amount
 * of a mis-keyed sale is a customer who was charged wrong. The rule defaults to
 * shortages only because that is what people ask for, and can be told to
 * include overages.
 *
 * A run of small variances in ONE direction is worth more than a single large
 * one, so the message reports the net as well as the worst.
 */

export type CashupVarianceItem = {
  shiftId: number
  terminalCode: string
  userName: string
  closedAt: Date | null
  counted: number
  expected: number
  variance: number
  note: string | null
}

export type CashupVarianceResult = {
  items: CashupVarianceItem[]
  total: number
  /** Everything added up: R200 short and R200 over is a different story to R0. */
  net: number
  shortages: number
  overages: number
  threshold: number
  shortagesOnly: boolean
  sinceDays: number
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * How far back a firing looks.
 *
 * Tied to the rule's own rhythm rather than fixed at "yesterday": a weekly rule
 * that looked back one day would silently ignore six days of drawers, which is
 * the kind of gap nobody notices until an audit.
 */
function windowDays(rule: AlertRule): number {
  if (rule.frequency === 'weekly') return 7
  if (rule.frequency === 'monthly') return 31
  return 1
}

export async function evaluateCashupVariance(
  siteId: number,
  rule: AlertRule,
): Promise<CashupVarianceResult> {
  const threshold = rule.config.threshold
  const shortagesOnly = rule.config.shortagesOnly
  const sinceDays = windowDays(rule)

  // Only CLOSED shifts: an open drawer has no variance yet, and its zeroes
  // would otherwise read as a perfectly balanced till.
  const direction = shortagesOnly ? `s.variance <= -?` : `ABS(s.variance) >= ?`
  const where = `
    s.closed_at IS NOT NULL
    AND s.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    AND ${direction}
  `
  const params = [sinceDays, threshold]

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(s.variance), 0) AS net,
            COALESCE(SUM(CASE WHEN s.variance < 0 THEN 1 ELSE 0 END), 0) AS shortages,
            COALESCE(SUM(CASE WHEN s.variance > 0 THEN 1 ELSE 0 END), 0) AS overages
       FROM shifts s
      WHERE ${where}`,
    params,
  )

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.terminal_code, s.user_name, s.closed_at,
            s.counted_total, s.expected_total, s.variance, s.variance_note
       FROM shifts s
      WHERE ${where}
      ORDER BY ABS(s.variance) DESC
      LIMIT ${READ_LIMIT}`,
    params,
  )

  return {
    total: Number(totals[0]?.n) || 0,
    net: Number(totals[0]?.net) || 0,
    shortages: Number(totals[0]?.shortages) || 0,
    overages: Number(totals[0]?.overages) || 0,
    threshold,
    shortagesOnly,
    sinceDays,
    items: rows.map((r) => ({
      shiftId: Number(r.id),
      terminalCode: String(r.terminal_code ?? ''),
      userName: String(r.user_name ?? '') || '(unknown)',
      closedAt: (r.closed_at as Date | null) ?? null,
      counted: Number(r.counted_total) || 0,
      expected: Number(r.expected_total) || 0,
      variance: Number(r.variance) || 0,
      note: r.variance_note ? String(r.variance_note) : null,
    })),
  }
}

export function cashupVarianceMessage(
  rule: AlertRule,
  result: CashupVarianceResult,
): AlertMessage {
  const n = result.total
  const shown = result.items.slice(0, TEXT_LINES)

  const lines = shown.map(
    (i) =>
      `${i.terminalCode || 'till'} · ${i.userName}: ${describe(i.variance)}${
        i.note ? ` — "${i.note}"` : ''
      }`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'cashup_variance',
    title: `Cash-up variance: ${count(n, 'drawer')} out by more than ${rands(result.threshold)}`,
    // The net is the sentence somebody acts on: a day of small shortages all in
    // the same direction is a pattern, not bad luck.
    summary: `${describe(result.net)} across ${count(n, 'drawer')} in the last ${
      result.sinceDays === 1 ? 'day' : `${result.sinceDays} days`
    }.`,
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'drawer')} out by more than ${rands(result.threshold)}.`,
      columns: [
        { header: 'Till' },
        { header: 'Cashier' },
        { header: 'Closed' },
        { header: 'Counted', align: 'right' },
        { header: 'Expected', align: 'right' },
        { header: 'Out by', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.terminalCode,
          i.userName,
          i.closedAt ? i.closedAt.toISOString().slice(0, 16).replace('T', ' ') : '',
          rands(i.counted),
          rands(i.expected),
          describe(i.variance),
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more, largest first.`] : []),
        result.shortagesOnly
          ? 'Overages were not counted — switch that on in the alert if you want both.'
          : `${count(result.shortages, 'shortage')} and ${count(result.overages, 'overage')}. An overage usually means a mis-keyed sale, not a windfall.`,
      ],
    }),
    href: '/sales/cashup',
  }
}

/** "R 120.00 short" / "R 40.00 over" — the direction said out loud. */
function describe(variance: number): string {
  if (variance === 0) return 'balanced'
  return variance < 0 ? `${rands(Math.abs(variance))} short` : `${rands(variance)} over`
}

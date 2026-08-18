import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Account customers at or near their credit limit.
 *
 * The point is to know BEFORE the awkward moment at the till. A limit that is
 * only discovered when a sale is refused makes the cashier the messenger and
 * the customer the audience — while the same fact, known that morning, is a
 * phone call between two people who do business together.
 *
 * ── WARNING BEFORE BREACH ────────────────────────────────────────────────
 *
 * The threshold is a PERCENTAGE, defaulting to 90: an account at 92% of its
 * limit is the one worth a call, because it is the one that will be refused
 * this week. Reporting only accounts already over the line would make the
 * alert a record of things that have already gone wrong.
 *
 * A customer with no limit set is not reported. "No limit" is a decision the
 * shop made, not an oversight this alert should second-guess — and folding
 * them in would bury the accounts that do have a limit.
 */

export type CreditLimitItem = {
  customerId: number
  code: string
  name: string
  balance: number
  creditLimit: number
  usedPct: number
  /** Already past the line, rather than merely close to it. */
  over: boolean
}

export type CreditLimitResult = {
  items: CreditLimitItem[]
  total: number
  /** How many are already over — the ones that will be refused today. */
  overCount: number
  /** What is owed beyond the limits, across everything found. */
  overBy: number
  warnAtPct: number
}

type Row = RowDataPacket & Record<string, unknown>

export async function evaluateCreditLimit(
  siteId: number,
  rule: AlertRule,
): Promise<CreditLimitResult> {
  const warnAtPct = rule.config.warnAtPct

  // status <> 'closed' rather than an is_archived flag: party tables carry a
  // four-state status here, and a closed account is not somebody to chase.
  const where = `
    c.status <> 'closed'
    AND COALESCE(c.credit_limit, 0) > 0
    AND (c.balance / c.credit_limit) * 100 >= ?
  `
  const params = [warnAtPct]

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN c.balance >= c.credit_limit THEN 1 ELSE 0 END), 0) AS over_count,
            COALESCE(SUM(GREATEST(c.balance - c.credit_limit, 0)), 0) AS over_by
       FROM customers c
      WHERE ${where}`,
    params,
  )

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT c.id, c.code, c.name, c.balance, c.credit_limit,
            (c.balance / c.credit_limit) * 100 AS used_pct
       FROM customers c
      WHERE ${where}
      ORDER BY used_pct DESC
      LIMIT ${READ_LIMIT}`,
    params,
  )

  return {
    total: Number(totals[0]?.n) || 0,
    overCount: Number(totals[0]?.over_count) || 0,
    overBy: Number(totals[0]?.over_by) || 0,
    warnAtPct,
    items: rows.map((r) => {
      const balance = Number(r.balance) || 0
      const creditLimit = Number(r.credit_limit) || 0
      return {
        customerId: Number(r.id),
        code: String(r.code ?? ''),
        name: String(r.name ?? '') || '(no name)',
        balance,
        creditLimit,
        usedPct: Number(r.used_pct) || 0,
        over: balance >= creditLimit,
      }
    }),
  }
}

export function creditLimitMessage(rule: AlertRule, result: CreditLimitResult): AlertMessage {
  const n = result.total
  const shown = result.items.slice(0, TEXT_LINES)

  const lines = shown.map(
    (i) =>
      `${i.name} (${i.code}): ${rands(i.balance)} of ${rands(i.creditLimit)} — ${i.usedPct.toFixed(0)}%${
        i.over ? ', over' : ''
      }`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'credit_limit',
    title: `Credit limits: ${count(n, 'account')} at ${result.warnAtPct}% or more`,
    // The accounts already over are the ones that will be refused at the till
    // today — that is the actionable half of the number.
    summary:
      result.overCount > 0
        ? `${count(result.overCount, 'account')} already over, by ${rands(result.overBy)} in total.`
        : 'None are over yet — these are the ones that will be soon.',
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'account customer')} at or above ${result.warnAtPct}% of their credit limit.`,
      columns: [
        { header: 'Customer' },
        { header: 'Code' },
        { header: 'Balance', align: 'right' },
        { header: 'Limit', align: 'right' },
        { header: 'Used', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.name,
          i.code,
          rands(i.balance),
          rands(i.creditLimit),
          `${i.usedPct.toFixed(0)}%${i.over ? ' — over' : ''}`,
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more, highest first.`] : []),
        'Customers with no credit limit set are not included.',
      ],
    }),
    href: '/customers',
  }
}

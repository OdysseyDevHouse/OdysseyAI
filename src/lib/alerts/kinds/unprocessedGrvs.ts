import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * Deliveries received but never finished.
 *
 * A draft GRV is the most expensive kind of unfinished work in a shop, because
 * nothing about it looks broken. The stock is physically on the shelf and being
 * sold; the system does not know it arrived. So on-hand figures are low, the
 * reorder suggestions want to buy it again, the margin on every sale of those
 * lines is computed against an old cost, and the supplier's account does not
 * show what is owed. Every one of those numbers looks perfectly plausible.
 *
 * ── WHY A GRACE PERIOD ───────────────────────────────────────────────────
 *
 * A delivery captured this morning and still open at lunchtime is somebody
 * doing their job. `days` (2 by default) is the line between "in progress" and
 * "forgotten": long enough that nobody is nagged mid-task, short enough that
 * stock is not invisible for a week.
 */

export type UnprocessedGrvItem = {
  documentId: number
  documentNumber: string
  supplierName: string
  /**
   * 'YYYY-MM-DD', already a string.
   *
   * The pool sets `dateStrings: ['DATE']`, so a DATE column arrives as text
   * while a DATETIME arrives as a Date — and document_date is a DATE. Typing
   * this as a Date and calling toISOString() on it is exactly the runtime
   * error that mistake produces, in a background sweep where nobody sees it.
   */
  documentDate: string | null
  daysWaiting: number
  totalIncl: number
  userName: string
}

export type UnprocessedGrvResult = {
  items: UnprocessedGrvItem[]
  total: number
  /** The value of stock the system does not know it has. */
  valueTotal: number
  days: number
}

type Row = RowDataPacket & Record<string, unknown>

export async function evaluateUnprocessedGrvs(
  siteId: number,
  rule: AlertRule,
): Promise<UnprocessedGrvResult> {
  const days = rule.config.days

  // A GRV in 'draft' is exactly the condition: received, captured, not posted.
  // Cancelled and finalised are both finished stories.
  const where = `
    d.doc_type = 'grv'
    AND d.status = 'draft'
    AND d.document_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
  `
  const params = [days]

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.total_incl), 0) AS value
       FROM purchase_documents d
      WHERE ${where}`,
    params,
  )

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.document_number, d.supplier_name, d.document_date, d.total_incl, d.user_name,
            DATEDIFF(CURDATE(), d.document_date) AS days_waiting
       FROM purchase_documents d
      WHERE ${where}
      ORDER BY d.document_date ASC
      LIMIT ${READ_LIMIT}`,
    params,
  )

  return {
    total: Number(totals[0]?.n) || 0,
    valueTotal: Number(totals[0]?.value) || 0,
    days,
    items: rows.map((r) => ({
      documentId: Number(r.id),
      documentNumber: String(r.document_number ?? '') || `#${r.id}`,
      supplierName: String(r.supplier_name ?? '') || '(no supplier)',
      documentDate: r.document_date ? String(r.document_date) : null,
      daysWaiting: Number(r.days_waiting) || 0,
      totalIncl: Number(r.total_incl) || 0,
      userName: String(r.user_name ?? ''),
    })),
  }
}

export function unprocessedGrvsMessage(
  rule: AlertRule,
  result: UnprocessedGrvResult,
): AlertMessage {
  const n = result.total
  const shown = result.items.slice(0, TEXT_LINES)
  const oldest = result.items[0]

  const lines = shown.map(
    (i) =>
      `${i.documentNumber} · ${i.supplierName}: ${rands(i.totalIncl)}, waiting ${i.daysWaiting} days`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'unprocessed_grvs',
    title: `Unprocessed deliveries: ${count(n, 'GRV')} worth ${rands(result.valueTotal)}`,
    // Says WHY it matters, because the condition itself sounds like paperwork.
    summary: `Stock the system does not know it has, so on-hand figures and margins are wrong until these are finished.${
      oldest ? ` The oldest has waited ${oldest.daysWaiting} days.` : ''
    }`,
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'delivery')} captured more than ${result.days} days ago and never finished.`,
      columns: [
        { header: 'GRV' },
        { header: 'Supplier' },
        { header: 'Date' },
        { header: 'Waiting', align: 'right' },
        { header: 'Value', align: 'right' },
        { header: 'Captured by' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.documentNumber,
          i.supplierName,
          i.documentDate ?? '',
          `${i.daysWaiting} days`,
          rands(i.totalIncl),
          i.userName,
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more, oldest first.`] : []),
        'Until a delivery is finished, its stock is not on hand and its cost is not on the supplier account.',
      ],
    }),
    href: '/purchasing',
  }
}

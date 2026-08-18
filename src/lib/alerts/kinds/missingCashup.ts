import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../../siteDb'
import { buildTableHtml, count, rands, EMAIL_ROWS, READ_LIMIT, TEXT_LINES } from '../message'
import type { AlertMessage } from '../message'
import type { AlertRule } from '../types'

/**
 * A drawer nobody counted.
 *
 * A shift that traded and was never closed is worse than one that closed
 * short: a shortage is a number somebody can investigate, while an uncounted
 * drawer is an absence of evidence. Nobody can say afterwards what was in it,
 * so nobody can be held to it — which is exactly the condition under which
 * money quietly stops arriving.
 *
 * ── WHY "STILL OPEN" IS NOT ENOUGH ───────────────────────────────────────
 *
 * A shift open right now is a till trading right now, which is normal. The
 * condition is a shift left open PAST ITS DAY: opened yesterday or earlier and
 * still not closed. That is the shape of a real miss — someone went home.
 *
 * A shift that traded nothing is reported separately in the message rather
 * than hidden: a till switched on and never used is a smaller problem than one
 * that took R14,000, but it is still an open drawer nobody closed off, and
 * suppressing it would teach people the alert is unreliable.
 */

export type MissingCashupItem = {
  shiftId: number
  terminalCode: string
  userName: string
  openedAt: Date | null
  hoursOpen: number
  /** What went through the till while it was open. */
  takings: number
}

export type MissingCashupResult = {
  items: MissingCashupItem[]
  total: number
  /** The money sitting behind uncounted drawers — the reason to act today. */
  takingsTotal: number
}

type Row = RowDataPacket & Record<string, unknown>

export async function evaluateMissingCashup(siteId: number): Promise<MissingCashupResult> {
  // Opened before today and still open. Not "older than 24 hours": a shift
  // opened at 08:00 that is still open at 07:00 the next morning is 23 hours
  // old and is unambiguously a miss, and the day boundary is the line a person
  // would draw themselves.
  const where = `s.closed_at IS NULL AND s.opened_at < CURDATE()`

  // The takings come from the shift's own sales rather than the drawer's
  // counted total, which does not exist yet — that is the whole problem.
  const takings = `(SELECT COALESCE(SUM(d.total_incl), 0)
                      FROM sales_documents d
                     WHERE d.shift_id = s.id AND d.status = 'finalised')`

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n, COALESCE(SUM(${takings}), 0) AS takings FROM shifts s WHERE ${where}`,
  )

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.terminal_code, s.user_name, s.opened_at,
            TIMESTAMPDIFF(HOUR, s.opened_at, NOW()) AS hours_open,
            ${takings} AS takings
       FROM shifts s
      WHERE ${where}
      ORDER BY takings DESC, s.opened_at ASC
      LIMIT ${READ_LIMIT}`,
  )

  return {
    total: Number(totals[0]?.n) || 0,
    takingsTotal: Number(totals[0]?.takings) || 0,
    items: rows.map((r) => ({
      shiftId: Number(r.id),
      terminalCode: String(r.terminal_code ?? ''),
      userName: String(r.user_name ?? '') || '(unknown)',
      openedAt: (r.opened_at as Date | null) ?? null,
      hoursOpen: Number(r.hours_open) || 0,
      takings: Number(r.takings) || 0,
    })),
  }
}

export function missingCashupMessage(
  rule: AlertRule,
  result: MissingCashupResult,
): AlertMessage {
  const n = result.total
  const withTakings = result.items.filter((i) => i.takings > 0).length
  const shown = result.items.slice(0, TEXT_LINES)

  const lines = shown.map(
    (i) =>
      `${i.terminalCode || 'till'} · ${i.userName}: open ${i.hoursOpen}h${
        i.takings > 0 ? `, ${rands(i.takings)} through it` : ', nothing sold'
      }`,
  )
  if (n > shown.length) lines.push(`…and ${n - shown.length} more.`)

  return {
    kind: 'missing_cashup',
    title: `Missing cash-up: ${count(n, 'drawer')} never counted`,
    summary:
      result.takingsTotal > 0
        ? `${rands(result.takingsTotal)} went through tills that were never cashed up.`
        : 'Tills were left open overnight, though nothing was sold on them.',
    lines,
    html: buildTableHtml({
      intro: `The "${rule.name}" alert found ${count(n, 'shift')} that opened before today and was never closed.`,
      columns: [
        { header: 'Till' },
        { header: 'Cashier' },
        { header: 'Opened' },
        { header: 'Open for', align: 'right' },
        { header: 'Takings', align: 'right' },
      ],
      rows: result.items
        .slice(0, EMAIL_ROWS)
        .map((i) => [
          i.terminalCode,
          i.userName,
          i.openedAt ? i.openedAt.toISOString().slice(0, 16).replace('T', ' ') : '',
          `${i.hoursOpen}h`,
          i.takings > 0 ? rands(i.takings) : '—',
        ]),
      notes: [
        ...(n > EMAIL_ROWS ? [`…and ${n - EMAIL_ROWS} more.`] : []),
        withTakings > 0
          ? `${count(withTakings, 'drawer')} took money and still has no count against it.`
          : 'None of these took any money — most likely a till switched on and left.',
      ],
    }),
    href: '/sales/cashup',
  }
}

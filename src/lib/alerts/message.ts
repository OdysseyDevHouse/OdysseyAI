/**
 * What an alert SAYS, and how each channel renders it.
 *
 * One message, four renderings: the bell gets the title, a one-line summary and
 * a link; email gets the full table; WhatsApp and SMS get a short plain-text
 * digest, because both are text-only and one is metered.
 *
 * The email HTML uses INLINE STYLES rather than the design system's tokens.
 * This lands in a mail client, where a stylesheet and a CSS variable are both
 * unavailable — the tokens would silently render as nothing.
 *
 * Pure and browser-safe: no database, no server-only import. The style-guide
 * preview renders the same builder the sender uses.
 */

export type AlertMessage = {
  kind: string
  /** "Low stock: 12 products at or below minimum" */
  title: string
  /** One line for the bell and the phone: what it means, or what was done. */
  summary: string
  /** Plain-text item lines, already capped by the evaluator. */
  lines: string[]
  /** The full email body. */
  html: string
  /** Where the bell row goes when somebody clicks it. */
  href: string
}

/**
 * Most rows any one check will READ out of the database.
 *
 * The email table shows 100 and the text summary 15, so anything beyond this is
 * fetched only to be counted — and a shop with a genuinely huge problem (every
 * product negative after a bad stocktake) must not drag tens of thousands of
 * rows through a background sweep to render a hundred.
 *
 * A check that caps its read MUST count separately. A cap that lies — "500
 * products" when the truth is 3,000 — is worse than a slow query, because the
 * number looks like an answer.
 */
export const READ_LIMIT = 500

/** Rows in the email table. */
export const EMAIL_ROWS = 100

/** Lines in the bell body, WhatsApp and SMS. */
export const TEXT_LINES = 15

export type TableColumn = {
  header: string
  align?: 'left' | 'right'
}

/**
 * The shared email body for list-shaped alerts: an intro line, a compact table,
 * notes underneath.
 */
export function buildTableHtml(opts: {
  intro: string
  columns: TableColumn[]
  /** Pre-formatted cell text, one array per row, in column order. */
  rows: string[][]
  /** The "…and N more" truncation notice, plus any advice worth giving. */
  notes?: string[]
}): string {
  const th = (c: TableColumn) =>
    `<th style="padding:6px 10px;text-align:${c.align ?? 'left'};border-bottom:2px solid #ccc;">${esc(c.header)}</th>`
  const td = (text: string, c: TableColumn | undefined) =>
    `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:${c?.align ?? 'left'};">${esc(text)}</td>`

  const body = opts.rows
    .map((r) => `<tr>${r.map((cell, i) => td(cell, opts.columns[i])).join('')}</tr>`)
    .join('')
  const notes = (opts.notes ?? [])
    .filter(Boolean)
    .map((n) => `<p style="margin:8px 0 0;color:#555;">${esc(n)}</p>`)
    .join('')

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222;">
  <p style="margin:0 0 10px;">${esc(opts.intro)}</p>
  <table style="border-collapse:collapse;min-width:520px;">
    <tr>${opts.columns.map(th).join('')}</tr>
    ${body}
  </table>
  ${notes}
</div>`
}

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** R 1 234.56 — matching the app's en-ZA look, for email and message text. */
export function rands(v: number): string {
  return `R ${new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)}`
}

/** "6" not "6.0000", but a real fraction is kept. */
export function qty(v: number): string {
  return String(Math.round(Number(v) * 10000) / 10000)
}

/** "12 products" / "1 product" — the plural rule, in one place. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * The text-only rendering, for WhatsApp and SMS.
 *
 * Capped at `maxLines` because a message that runs to three screens is one
 * nobody reads — the detail is in the email, and the point of the phone is to
 * know that something needs attention.
 */
export function messageText(msg: AlertMessage, maxLines = 8): string {
  const shown = msg.lines.slice(0, maxLines)
  const left = msg.lines.length - shown.length
  return [msg.title, ...shown, left > 0 ? `…and ${left} more.` : '', msg.summary]
    .filter(Boolean)
    .join('\n')
}

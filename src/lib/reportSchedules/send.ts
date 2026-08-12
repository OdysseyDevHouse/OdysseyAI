import 'server-only'
import { send as sendMail, isConfigured as mailConfigured } from '../mail'
import { escapeHtml } from '../orderEmailTemplate'
import { formatCell, exportCell } from '../reportBuilder/format'
import { resolveReport } from '../reportBuilder/resolve'
import { runBuilderSpec } from '../reportBuilder/run'
import { reportColumnsFor, applyStoreColumns } from '../site/reportColumns'
import { toCsv, type ExportColumn } from '../export/table'
import { capabilitiesForRole, can, type Capability } from '../site/permissions'
import { getUser, listUsers } from '../site/users'
import {
  finishRun,
  recordLastRun,
  type ReportSchedule,
} from '../site/reportSchedules'

/**
 * Running one scheduled report and emailing it.
 *
 * ── THE OWNER'S PERMISSIONS, NOT THE SITE'S ──────────────────────────────────
 *
 * Every send re-resolves the rule's owner and runs the report under THEIR
 * capabilities. A schedule must never become a way to email data past the
 * checks every interactive path enforces, and there is no session at 07:00 to
 * check against. An owner who has been suspended, deleted, or had the
 * capability removed causes the occurrence to be SKIPPED with a reason —
 * never run with someone else's rights, and never silently.
 */

export type SendOutcome =
  | { status: 'sent'; recipients: string[]; rowCount: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

export async function runAndSend(
  siteId: number,
  schedule: ReportSchedule,
  runId: number,
  dueAt: Date,
): Promise<SendOutcome> {
  const outcome = await execute(siteId, schedule, dueAt)

  await finishRun(siteId, runId, {
    status: outcome.status,
    recipients: outcome.status === 'sent' ? outcome.recipients.join(', ') : '',
    rowCount: outcome.status === 'sent' ? outcome.rowCount : 0,
    errorText:
      outcome.status === 'skipped'
        ? outcome.reason
        : outcome.status === 'failed'
          ? outcome.error
          : '',
  })

  await recordLastRun(
    siteId,
    schedule.id,
    outcome.status,
    outcome.status === 'skipped' ? outcome.reason : outcome.status === 'failed' ? outcome.error : '',
  )

  return outcome
}

async function execute(
  siteId: number,
  schedule: ReportSchedule,
  dueAt: Date,
): Promise<SendOutcome> {
  if (!mailConfigured()) {
    return { status: 'skipped', reason: 'Email is not set up on this site.' }
  }

  // ── who it runs as ────────────────────────────────────────────────────────
  if (!schedule.ownerUserId) {
    return { status: 'skipped', reason: 'This schedule has no owner and cannot run.' }
  }
  const owner = await getUser(siteId, schedule.ownerUserId)
  if (!owner || !owner.isActive) {
    return { status: 'skipped', reason: 'The person this schedule runs as is no longer active.' }
  }

  const capabilities = await capabilitiesForRole(siteId, owner.roleId)
  const allow = (c: Capability) => can(capabilities, c)

  if (!allow('reports.view') || !allow('reports.schedule')) {
    return {
      status: 'skipped',
      reason: `${owner.name} no longer has permission to send scheduled reports.`,
    }
  }

  // ── what it runs ──────────────────────────────────────────────────────────
  const report = await resolveReport(siteId, schedule.resolvedReportId)
  if (!report) {
    return { status: 'skipped', reason: 'The report this schedule points at no longer exists.' }
  }
  if (report.permission && !allow(report.permission)) {
    return {
      status: 'skipped',
      reason: `${owner.name} no longer has access to this report.`,
    }
  }

  // ── who receives it ───────────────────────────────────────────────────────
  const recipients = await resolveRecipients(siteId, schedule)
  if (recipients.length === 0) {
    return { status: 'skipped', reason: 'No one to send to — every recipient has been removed.' }
  }

  // ── run it ────────────────────────────────────────────────────────────────
  let result
  try {
    const spec = {
      ...report.spec,
      period:
        schedule.periodKey === 'custom'
          ? { key: schedule.periodKey, from: schedule.periodFrom, to: schedule.periodTo }
          : { key: schedule.periodKey },
    }
    // Resolve the period against the DUE time, not "now" — a tick that runs
    // late must still send the report the occurrence was for.
    result = await runBuilderSpec(siteId, spec, allow, { now: dueAt })
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'The report failed to run.' }
  }

  /*
   * The store's columns and order, applied once here so the three renderers
   * below — plain text, HTML and the CSV attachment — all agree with the screen
   * and with each other. A scheduled email is the copy that lands in an inbox
   * every Monday; it showing a column the store retired would be the last place
   * anyone would think to look.
   */
  result = {
    ...result,
    columns: applyStoreColumns(
      result.columns,
      await reportColumnsFor(siteId, report.id, result.columns.map((c) => c.key)),
    ),
  }

  // ── build the mail ────────────────────────────────────────────────────────
  const subject = `${report.name} — ${result.range.from} to ${result.range.to}`
  const text = plainText(schedule, report.name, result)
  const html = schedule.includeHtml ? htmlBody(schedule, report.name, result) : undefined

  const attachments = schedule.attachCsv
    ? [
        {
          filename: `${slug(report.name)}-${result.range.to}.csv`,
          content: Buffer.from(csvFor(result), 'utf8'),
          contentType: 'text/csv; charset=utf-8',
        },
      ]
    : undefined

  // One mail per recipient rather than a shared To: line — a scheduled report
  // can carry commercially sensitive figures, and disclosing who else receives
  // it is not this feature's business.
  const delivered: string[] = []
  const failures: string[] = []
  for (const to of recipients) {
    const sent = await sendMail({ to, subject, text, html, attachments })
    if (sent.ok) delivered.push(to)
    else failures.push(`${to}: ${sent.error}`)
  }

  if (delivered.length === 0) {
    return { status: 'failed', error: failures.join('; ').slice(0, 500) || 'No mail could be sent.' }
  }

  return { status: 'sent', recipients: delivered, rowCount: result.rows.length }
}

/**
 * The addresses to send to.
 *
 * A named user resolves to their CURRENT email on every send — that is the
 * whole reason the user id is stored rather than the address. A user who is
 * suspended, deleted, or has no email simply drops out, without anyone having
 * to remember which schedules they were on.
 */
async function resolveRecipients(
  siteId: number,
  schedule: ReportSchedule,
): Promise<string[]> {
  const out = new Set<string>()

  if (schedule.recipientUserIds.length > 0) {
    const users = await listUsers(siteId)
    for (const id of schedule.recipientUserIds) {
      const user = users.find((u) => u.id === id)
      if (user?.isActive && user.email) out.add(user.email.trim().toLowerCase())
    }
  }

  for (const email of schedule.recipientEmails) {
    const trimmed = email.trim().toLowerCase()
    if (trimmed.includes('@')) out.add(trimmed)
  }

  return [...out]
}

/* ── rendering ─────────────────────────────────────────────────────────────── */

type RunResult = Awaited<ReturnType<typeof runBuilderSpec>>

/** How many rows go in the email body before it stops being readable. */
const HTML_ROW_LIMIT = 50

function plainText(schedule: ReportSchedule, name: string, result: RunResult): string {
  const lines: string[] = []
  if (schedule.message) lines.push(schedule.message, '')
  lines.push(name, `${result.range.from} to ${result.range.to}`, '')

  if (result.rows.length === 0) {
    lines.push('Nothing to report for this period.')
  } else {
    lines.push(`${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.`)
    for (const col of result.columns) {
      if (!col.total) continue
      lines.push(`${col.label}: ${formatCell(result.totals[col.key], col.type)}`)
    }
    if (schedule.attachCsv) lines.push('', 'The full report is attached as a spreadsheet.')
  }

  return lines.join('\n')
}

/**
 * The report as a table in the email body.
 *
 * Inline styles only — every mail client strips a stylesheet, and a report that
 * arrives as an unstyled wall of text on a phone is the one people stop
 * opening.
 */
function htmlBody(schedule: ReportSchedule, name: string, result: RunResult): string {
  const rows = result.rows.slice(0, HTML_ROW_LIMIT)

  const head = result.columns
    .map(
      (c) =>
        `<th style="padding:6px 10px;text-align:${c.numeric ? 'right' : 'left'};border-bottom:2px solid #d0d5dd;font-size:12px;color:#475467;white-space:nowrap;">${escapeHtml(c.label)}</th>`,
    )
    .join('')

  const body = rows
    .map((row) => {
      const cells = result.columns
        .map((c) => {
          const value = formatCell(row[c.key], c.type)
          const negative = c.numeric && Number(row[c.key]) < 0
          return `<td style="padding:5px 10px;text-align:${c.numeric ? 'right' : 'left'};border-bottom:1px solid #eaecf0;font-size:13px;${negative ? 'color:#b42318;' : ''}">${escapeHtml(value)}</td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  const hasTotals = result.columns.some((c) => c.total)
  const totals = hasTotals
    ? `<tr>${result.columns
        .map((c, i) => {
          const value = c.total ? formatCell(result.totals[c.key], c.type) : i === 0 ? `${result.rows.length} rows` : ''
          return `<td style="padding:7px 10px;text-align:${c.numeric ? 'right' : 'left'};border-top:2px solid #d0d5dd;font-size:13px;font-weight:600;">${escapeHtml(value)}</td>`
        })
        .join('')}</tr>`
    : ''

  const truncated =
    result.rows.length > HTML_ROW_LIMIT
      ? `<p style="font-size:12px;color:#667085;margin:12px 0 0;">Showing the first ${HTML_ROW_LIMIT} of ${result.rows.length} rows${schedule.attachCsv ? ' — the full report is attached.' : '.'}</p>`
      : ''

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16191d;max-width:900px;">
  ${schedule.message ? `<p style="font-size:14px;margin:0 0 16px;">${escapeHtml(schedule.message)}</p>` : ''}
  <h2 style="font-size:18px;margin:0 0 4px;">${escapeHtml(name)}</h2>
  <p style="font-size:13px;color:#667085;margin:0 0 16px;">${escapeHtml(result.range.from)} to ${escapeHtml(result.range.to)}</p>
  ${
    result.rows.length === 0
      ? '<p style="font-size:14px;color:#667085;">Nothing to report for this period.</p>'
      : `<table style="border-collapse:collapse;width:100%;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${totals}</tfoot></table>${truncated}`
  }
</div>`
}

function csvFor(result: RunResult): string {
  const columns: ExportColumn<Record<string, unknown>>[] = result.columns.map((col) => ({
    header: col.label,
    value: (row) => exportCell(row[col.key], col.type),
    money: col.type === 'currency',
  }))
  return toCsv(result.rows, columns)
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'report'
  )
}

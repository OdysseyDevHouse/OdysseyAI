import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import type { PeriodKey } from '../reportBuilder/spec'

/**
 * Scheduled reports — "email me the cash-up at 07:00 every day".
 *
 * A rule is a REPORT + a WHEN + a WHO, and nothing about the report's data is
 * stored: the report id resolves through the registry, the period re-resolves
 * on every run, and recipients resolve fresh out of `users`. See the header of
 * sql/site/054_reports.sql for why each of those is a reference rather than a
 * copy.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly'

export type ReportSchedule = {
  id: number
  name: string
  isActive: boolean
  reportKind: 'builtin' | 'saved'
  reportKey: string
  savedReportId: number | null
  /** The id the report registry understands, for either kind. */
  resolvedReportId: string
  periodKey: PeriodKey
  periodFrom: string
  periodTo: string
  frequency: Frequency
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
  recipientUserIds: number[]
  recipientEmails: string[]
  attachCsv: boolean
  includeHtml: boolean
  message: string
  ownerUserId: number | null
  createdByName: string
  lastRunAt: Date | null
  lastRunStatus: string
  lastRunError: string
}

type Row = RowDataPacket & Record<string, unknown>

function mapSchedule(r: Row): ReportSchedule {
  const savedReportId = r.saved_report_id === null ? null : Number(r.saved_report_id)
  const reportKind = String(r.report_kind) as 'builtin' | 'saved'
  return {
    id: Number(r.id),
    name: String(r.name),
    isActive: !!r.is_active,
    reportKind,
    reportKey: String(r.report_key ?? ''),
    savedReportId,
    resolvedReportId:
      reportKind === 'saved' ? `saved:${savedReportId ?? 0}` : String(r.report_key ?? ''),
    periodKey: String(r.period_key) as PeriodKey,
    periodFrom: String(r.period_from ?? ''),
    periodTo: String(r.period_to ?? ''),
    frequency: String(r.frequency) as Frequency,
    sendTime: String(r.send_time),
    daysOfWeek: String(r.days_of_week),
    dayOfMonth: Number(r.day_of_month),
    recipientUserIds: parseIds(String(r.recipient_user_ids ?? '')),
    recipientEmails: parseList(String(r.recipient_emails ?? '')),
    attachCsv: !!r.attach_csv,
    includeHtml: !!r.include_html,
    message: String(r.message ?? ''),
    ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
    createdByName: String(r.created_by_name ?? ''),
    lastRunAt: (r.last_run_at as Date | null) ?? null,
    lastRunStatus: String(r.last_run_status ?? ''),
    lastRunError: String(r.last_run_error ?? ''),
  }
}

function parseList(s: string): string[] {
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function parseIds(s: string): number[] {
  return parseList(s)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
}

const COLUMNS = `id, name, is_active, report_kind, report_key, saved_report_id,
                 period_key, period_from, period_to, frequency, send_time,
                 days_of_week, day_of_month, recipient_user_ids, recipient_emails,
                 attach_csv, include_html, message, owner_user_id, created_by_name,
                 last_run_at, last_run_status, last_run_error`

export async function listSchedules(siteId: number): Promise<ReportSchedule[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM report_schedules ORDER BY is_active DESC, name`,
  )
  return rows.map(mapSchedule)
}

export async function getSchedule(siteId: number, id: number): Promise<ReportSchedule | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM report_schedules WHERE id = ?`,
    [id],
  )
  return row ? mapSchedule(row) : null
}

/** Only the active ones, for the tick. */
export async function listActiveSchedules(siteId: number): Promise<ReportSchedule[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM report_schedules WHERE is_active = 1`,
  )
  return rows.map(mapSchedule)
}

export type ScheduleInput = {
  name: string
  reportId: string
  periodKey: PeriodKey
  periodFrom?: string
  periodTo?: string
  frequency: Frequency
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
  recipientUserIds: number[]
  recipientEmails: string[]
  attachCsv: boolean
  includeHtml: boolean
  message: string
  isActive: boolean
}

/** Split the one-id-space report reference back into its two columns. */
function splitReportId(reportId: string): { kind: 'builtin' | 'saved'; key: string; savedId: number | null } {
  if (reportId.startsWith('saved:')) {
    const savedId = Number(reportId.slice(6))
    return { kind: 'saved', key: '', savedId: Number.isInteger(savedId) ? savedId : null }
  }
  return { kind: 'builtin', key: reportId, savedId: null }
}

export async function createSchedule(
  siteId: number,
  input: ScheduleInput,
  actor: { userId: number; userName: string },
): Promise<number> {
  const target = splitReportId(input.reportId)
  const result = await siteExecute(
    siteId,
    `INSERT INTO report_schedules
       (name, is_active, report_kind, report_key, saved_report_id,
        period_key, period_from, period_to,
        frequency, send_time, days_of_week, day_of_month,
        recipient_user_ids, recipient_emails,
        attach_csv, include_html, message,
        owner_user_id, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.slice(0, 120),
      input.isActive ? 1 : 0,
      target.kind,
      target.key.slice(0, 64),
      target.savedId,
      input.periodKey,
      input.periodFrom ?? '',
      input.periodTo ?? '',
      input.frequency,
      input.sendTime,
      input.daysOfWeek,
      input.dayOfMonth,
      input.recipientUserIds.join(','),
      input.recipientEmails.join(',').slice(0, 2000),
      input.attachCsv ? 1 : 0,
      input.includeHtml ? 1 : 0,
      input.message.slice(0, 500),
      // The rule runs under whoever created it: their capabilities are
      // re-checked on every send, because there is no session at 07:00.
      actor.userId,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
  return result.insertId
}

export async function updateSchedule(
  siteId: number,
  id: number,
  input: ScheduleInput,
): Promise<void> {
  const target = splitReportId(input.reportId)
  await siteExecute(
    siteId,
    `UPDATE report_schedules SET
       name = ?, is_active = ?, report_kind = ?, report_key = ?, saved_report_id = ?,
       period_key = ?, period_from = ?, period_to = ?,
       frequency = ?, send_time = ?, days_of_week = ?, day_of_month = ?,
       recipient_user_ids = ?, recipient_emails = ?,
       attach_csv = ?, include_html = ?, message = ?
     WHERE id = ?`,
    [
      input.name.slice(0, 120),
      input.isActive ? 1 : 0,
      target.kind,
      target.key.slice(0, 64),
      target.savedId,
      input.periodKey,
      input.periodFrom ?? '',
      input.periodTo ?? '',
      input.frequency,
      input.sendTime,
      input.daysOfWeek,
      input.dayOfMonth,
      input.recipientUserIds.join(','),
      input.recipientEmails.join(',').slice(0, 2000),
      input.attachCsv ? 1 : 0,
      input.includeHtml ? 1 : 0,
      input.message.slice(0, 500),
      id,
    ],
  )
}

export async function setScheduleActive(
  siteId: number,
  id: number,
  active: boolean,
): Promise<void> {
  await siteExecute(siteId, `UPDATE report_schedules SET is_active = ? WHERE id = ?`, [
    active ? 1 : 0,
    id,
  ])
}

export async function deleteSchedule(siteId: number, id: number): Promise<void> {
  await siteExecute(siteId, `DELETE FROM report_schedule_runs WHERE schedule_id = ?`, [id])
  await siteExecute(siteId, `DELETE FROM report_schedules WHERE id = ?`, [id])
}

/* ── the run ledger ────────────────────────────────────────────────────────── */

export type ScheduleRun = {
  id: number
  scheduleId: number
  dueAt: Date
  status: 'claimed' | 'sent' | 'failed' | 'skipped'
  finishedAt: Date | null
  recipients: string
  rowCount: number
  attempts: number
  errorText: string
}

export async function listRuns(
  siteId: number,
  scheduleId: number,
  limit = 20,
): Promise<ScheduleRun[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, schedule_id, due_at, status, finished_at, recipients, row_count, attempts, error_text
       FROM report_schedule_runs
      WHERE schedule_id = ?
      ORDER BY due_at DESC
      LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    [scheduleId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    scheduleId: Number(r.schedule_id),
    dueAt: r.due_at as Date,
    status: String(r.status) as ScheduleRun['status'],
    finishedAt: (r.finished_at as Date | null) ?? null,
    recipients: String(r.recipients ?? ''),
    rowCount: Number(r.row_count ?? 0),
    attempts: Number(r.attempts ?? 0),
    errorText: String(r.error_text ?? ''),
  }))
}

/**
 * Claim one occurrence, returning false when someone already has it.
 *
 * The UNIQUE(schedule_id, due_at) key IS the claim: whoever wins the INSERT
 * sends, everyone else gets a duplicate-key error and does nothing. This is
 * correct across processes and machines because the uniqueness is enforced by
 * the one thing they share — the database — rather than by any in-process lock.
 */
export async function claimRun(
  siteId: number,
  scheduleId: number,
  dueAt: Date,
): Promise<number | null> {
  try {
    const result = await siteExecute(
      siteId,
      `INSERT INTO report_schedule_runs (schedule_id, due_at, status) VALUES (?, ?, 'claimed')`,
      [scheduleId, dueAt],
    )
    return result.insertId
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') return null
    throw e
  }
}

export async function finishRun(
  siteId: number,
  runId: number,
  outcome: {
    status: 'sent' | 'failed' | 'skipped'
    recipients?: string
    rowCount?: number
    errorText?: string
  },
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE report_schedule_runs
        SET status = ?, finished_at = NOW(), recipients = ?, row_count = ?, error_text = ?
      WHERE id = ?`,
    [
      outcome.status,
      (outcome.recipients ?? '').slice(0, 500),
      outcome.rowCount ?? 0,
      (outcome.errorText ?? '').slice(0, 500),
      runId,
    ],
  )
}

/** Observability only — the ledger above decides whether a send happens. */
export async function recordLastRun(
  siteId: number,
  scheduleId: number,
  status: string,
  error = '',
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE report_schedules
        SET last_run_at = NOW(), last_run_status = ?, last_run_error = ?
      WHERE id = ?`,
    [status.slice(0, 20), error.slice(0, 500), scheduleId],
  )
}

/**
 * Re-claim occurrences abandoned by a process that died mid-send.
 *
 * Without this, one crash parks a rule forever: the claim row exists, so no
 * later tick will take the occurrence, and the report silently stops arriving.
 */
export async function reclaimStaleRuns(siteId: number, olderThanMinutes = 30): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE report_schedule_runs
        SET status = 'failed', error_text = 'Abandoned — the process did not finish.',
            finished_at = NOW()
      WHERE status = 'claimed'
        AND claimed_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [Math.max(5, Math.floor(olderThanMinutes))],
  )
}

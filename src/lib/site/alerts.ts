import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import {
  readConfig,
  type AlertKind,
  type AlertRule,
  type AlertRuleInput,
  type AlertRunStatus,
  type Frequency,
} from '../alerts/types'

/**
 * Alert rules and their run ledger — the storage half of alerts & automations.
 *
 * A structural sibling of reportSchedules.ts, deliberately: the two features
 * solve the same problem (an unattended thing that must fire exactly once per
 * occurrence, under an owner's capabilities, with a history worth showing), so
 * they share a vocabulary rather than each inventing one.
 *
 * See sql/site/186_alerts.sql for the tables and why each column is a
 * reference rather than a copy.
 */

type Row = RowDataPacket & Record<string, unknown>

const COLUMNS = `id, kind, name, is_active, frequency, send_time, days_of_week, day_of_month,
                 config_json, notify_bell, notify_email, notify_whatsapp, notify_sms,
                 recipient_user_ids, recipient_emails, whatsapp_numbers, sms_numbers,
                 owner_user_id, created_by_name,
                 last_run_at, last_run_status, last_run_error`

function mapRule(r: Row): AlertRule {
  const kind = String(r.kind) as AlertKind
  return {
    id: Number(r.id),
    kind,
    name: String(r.name),
    isActive: !!r.is_active,
    frequency: String(r.frequency) as Frequency,
    sendTime: String(r.send_time),
    daysOfWeek: String(r.days_of_week),
    dayOfMonth: Number(r.day_of_month),
    // Parsed sceptically — a malformed blob becomes the defaults, never a throw
    // inside a sweep that is running over every rule on every site.
    config: readConfig(kind, r.config_json as string | null),
    notifyBell: !!r.notify_bell,
    notifyEmail: !!r.notify_email,
    notifyWhatsapp: !!r.notify_whatsapp,
    notifySms: !!r.notify_sms,
    recipientUserIds: parseIds(String(r.recipient_user_ids ?? '')),
    recipientEmails: parseList(String(r.recipient_emails ?? '')),
    whatsappNumbers: parseList(String(r.whatsapp_numbers ?? '')),
    smsNumbers: parseList(String(r.sms_numbers ?? '')),
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

/* ── reading ───────────────────────────────────────────────────────────────── */

export async function listRules(siteId: number): Promise<AlertRule[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM alert_rules ORDER BY is_active DESC, name`,
  )
  return rows.map(mapRule)
}

export async function getRule(siteId: number, id: number): Promise<AlertRule | null> {
  const row = await siteQueryOne<Row>(siteId, `SELECT ${COLUMNS} FROM alert_rules WHERE id = ?`, [
    id,
  ])
  return row ? mapRule(row) : null
}

/** Only the live ones, for the tick. */
export async function listActiveRules(siteId: number): Promise<AlertRule[]> {
  const rows = await siteQuery<Row>(siteId, `SELECT ${COLUMNS} FROM alert_rules WHERE is_active = 1`)
  return rows.map(mapRule)
}

/* ── writing ───────────────────────────────────────────────────────────────── */

/** The knobs stored for a kind, as the JSON blob config_json holds. */
function configJson(input: AlertRuleInput): string {
  return JSON.stringify(input.config ?? {})
}

/** The values shared by insert and update, in one place so they cannot drift. */
function ruleValues(input: AlertRuleInput): unknown[] {
  return [
    input.kind,
    input.name.trim().slice(0, 120),
    input.isActive ? 1 : 0,
    input.frequency,
    input.sendTime,
    input.daysOfWeek,
    input.dayOfMonth,
    configJson(input),
    input.notifyBell ? 1 : 0,
    input.notifyEmail ? 1 : 0,
    input.notifyWhatsapp ? 1 : 0,
    input.notifySms ? 1 : 0,
    input.recipientUserIds.join(',').slice(0, 500),
    input.recipientEmails.join(',').slice(0, 2000),
    input.whatsappNumbers.join(',').slice(0, 500),
    input.smsNumbers.join(',').slice(0, 500),
  ]
}

export async function createRule(
  siteId: number,
  input: AlertRuleInput,
  actor: { userId: number; userName: string },
): Promise<number> {
  const result = await siteExecute(
    siteId,
    `INSERT INTO alert_rules
       (kind, name, is_active, frequency, send_time, days_of_week, day_of_month,
        config_json, notify_bell, notify_email, notify_whatsapp, notify_sms,
        recipient_user_ids, recipient_emails, whatsapp_numbers, sms_numbers,
        owner_user_id, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ...ruleValues(input),
      // The rule runs under whoever created it: their capabilities are
      // re-checked on every firing, because there is no session at 07:00.
      actor.userId,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
  return result.insertId
}

/**
 * Ownership is deliberately NOT updated here.
 *
 * A rule keeps answering to the person who created it even after someone else
 * edits it — otherwise editing a colleague's alert would quietly re-point it at
 * your own capabilities, which is a way to have a rule act with access its
 * author never had. Changing the owner is its own decision, not a side effect
 * of fixing a typo in the name.
 */
export async function updateRule(
  siteId: number,
  id: number,
  input: AlertRuleInput,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE alert_rules SET
       kind = ?, name = ?, is_active = ?, frequency = ?, send_time = ?,
       days_of_week = ?, day_of_month = ?, config_json = ?,
       notify_bell = ?, notify_email = ?, notify_whatsapp = ?, notify_sms = ?,
       recipient_user_ids = ?, recipient_emails = ?, whatsapp_numbers = ?, sms_numbers = ?
     WHERE id = ?`,
    [...ruleValues(input), id],
  )
}

export async function setRuleActive(siteId: number, id: number, active: boolean): Promise<void> {
  await siteExecute(siteId, `UPDATE alert_rules SET is_active = ? WHERE id = ?`, [
    active ? 1 : 0,
    id,
  ])
}

/**
 * Turn a rule off with a reason on its card.
 *
 * The tick's answer to "this rule's owner has lost access": pausing it and
 * saying why beats running it under capabilities nobody holds, and beats
 * deleting it — the shop still has the rule, and can re-own it.
 */
export async function deactivateRule(siteId: number, id: number, reason: string): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE alert_rules
        SET is_active = 0, last_run_status = 'skipped', last_run_error = ?, last_run_at = NOW()
      WHERE id = ?`,
    [reason.slice(0, 500), id],
  )
}

export async function deleteRule(siteId: number, id: number): Promise<void> {
  // The ledger is ON DELETE CASCADE, but the explicit delete keeps this honest
  // on a site whose foreign keys were not created (schema drifts between sites).
  await siteExecute(siteId, `DELETE FROM alert_rule_runs WHERE rule_id = ?`, [id])
  await siteExecute(siteId, `DELETE FROM alert_rules WHERE id = ?`, [id])
}

/* ── the run ledger ────────────────────────────────────────────────────────── */

export type AlertRun = {
  id: number
  ruleId: number
  dueAt: Date
  status: AlertRunStatus
  finishedAt: Date | null
  /** What the check found. 0 is the good day. */
  itemCount: number
  /** What the check DID — documents created in the owner's name. */
  createdDocs: string
  recipients: string
  attempts: number
  errorText: string
}

export async function listRuns(siteId: number, ruleId: number, limit = 20): Promise<AlertRun[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, rule_id, due_at, status, finished_at, item_count, created_docs,
            recipients, attempts, error_text
       FROM alert_rule_runs
      WHERE rule_id = ?
      ORDER BY due_at DESC
      LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
    [ruleId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    ruleId: Number(r.rule_id),
    dueAt: r.due_at as Date,
    status: String(r.status) as AlertRunStatus,
    finishedAt: (r.finished_at as Date | null) ?? null,
    itemCount: Number(r.item_count ?? 0),
    createdDocs: String(r.created_docs ?? ''),
    recipients: String(r.recipients ?? ''),
    attempts: Number(r.attempts ?? 0),
    errorText: String(r.error_text ?? ''),
  }))
}

/**
 * Claim one occurrence, returning null when somebody already has it.
 *
 * The UNIQUE (rule_id, due_at) key IS the claim: whoever wins the INSERT runs
 * the check, everyone else gets a duplicate-key error and does nothing. This
 * holds across processes and machines because the uniqueness is enforced by the
 * one thing they share — the database — rather than by any in-process lock.
 */
export async function claimRun(
  siteId: number,
  ruleId: number,
  dueAt: Date,
): Promise<number | null> {
  try {
    const result = await siteExecute(
      siteId,
      `INSERT INTO alert_rule_runs (rule_id, due_at, status) VALUES (?, ?, 'claimed')`,
      [ruleId, dueAt],
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
    itemCount?: number
    createdDocs?: string[]
    recipients?: string[]
    errorText?: string
  },
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE alert_rule_runs
        SET status = ?, finished_at = NOW(), item_count = ?, created_docs = ?,
            recipients = ?, error_text = ?
      WHERE id = ?`,
    [
      outcome.status,
      Math.max(0, Math.round(outcome.itemCount ?? 0)),
      joinCapped(outcome.createdDocs ?? []),
      joinCapped(outcome.recipients ?? []),
      (outcome.errorText ?? '').slice(0, 500),
      runId,
    ],
  )
}

/**
 * Join a list into a VARCHAR(500) without cutting an entry in half.
 *
 * A blind slice turns "PO-000012, PO-000013" into "PO-000012, PO-0000" — an
 * audit trail of what an automation CREATED that reads as a corrupt document
 * number. Whole entries only, with an honest count of what did not fit.
 */
function joinCapped(values: string[], max = 500): string {
  const kept: string[] = []
  let length = 0
  for (const raw of values) {
    const v = String(raw).trim()
    if (!v) continue
    const cost = (kept.length ? 2 : 0) + v.length
    // Leave room for the "(+N more)" suffix if anything is left over.
    if (length + cost > max - 12 && kept.length) break
    kept.push(v)
    length += cost
  }
  const left = values.length - kept.length
  const joined = kept.join(', ')
  return (left > 0 ? `${joined} (+${left} more)` : joined).slice(0, max)
}

/** Observability only — the ledger above decides whether a check runs. */
export async function recordLastRun(
  siteId: number,
  ruleId: number,
  status: string,
  error = '',
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE alert_rules
        SET last_run_at = NOW(), last_run_status = ?, last_run_error = ?
      WHERE id = ?`,
    [status.slice(0, 20), error.slice(0, 500), ruleId],
  )
}

/**
 * Re-claim occurrences abandoned by a process that died mid-check.
 *
 * Without this, one crash parks a rule forever: the claim row exists, so no
 * later tick takes the occurrence, and the alert silently stops watching. The
 * failure mode of an alert going quiet is that nobody is told — and its
 * success state is also silence, which is exactly why this must self-heal.
 */
export async function reclaimStaleRuns(siteId: number, olderThanMinutes = 30): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE alert_rule_runs
        SET status = 'failed', error_text = 'Abandoned — the process did not finish.',
            finished_at = NOW()
      WHERE status = 'claimed'
        AND claimed_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [Math.max(5, Math.floor(olderThanMinutes))],
  )
}

/**
 * Burn the most recent past occurrence when a rule is created.
 *
 * A rule created at 19:00 for "07:00 daily" must start tomorrow, not fire an
 * hour of stale intent the moment it is saved. Claiming the occurrence as
 * skipped is how: the tick then finds it already taken.
 */
export async function skipFirstOccurrence(
  siteId: number,
  ruleId: number,
  dueAt: Date,
): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO alert_rule_runs (rule_id, due_at, status, finished_at, error_text)
       VALUES (?, ?, 'skipped', NOW(), ?)`,
      [ruleId, dueAt, 'Skipped: this check had already passed when the alert was created.'],
    )
  } catch (e) {
    // Already claimed by a tick between the INSERT above and now: nothing to do.
    if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e
  }
}

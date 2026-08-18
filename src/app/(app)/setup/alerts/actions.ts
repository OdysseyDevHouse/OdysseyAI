'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { lastDueAt } from '@/lib/reportSchedules/due'
import { actingCapability, runRuleNow } from '@/lib/alerts/tick'
import {
  createRule,
  deleteRule,
  getRule,
  listRuns,
  setRuleActive,
  skipFirstOccurrence,
  updateRule,
  type AlertRun,
} from '@/lib/site/alerts'
import {
  isAlertKind,
  readConfig,
  validateAlertRule,
  type AlertConfig,
  type AlertRuleInput,
} from '@/lib/alerts/types'

/**
 * Server side of alerts & automations.
 *
 * Every call re-checks the caller's capability, and the unattended runs do the
 * same check against the rule's stored owner (see lib/alerts/tick.ts). Same
 * conventions as reports/schedules/actions.ts.
 */

export type AlertResult = { ok: true; id?: number } | { ok: false; error: string }

const PATH = '/setup/alerts'

/**
 * Everything the client sent, re-read from scratch.
 *
 * The form validated the same way in the browser, and that is worth nothing
 * here: an action is a public endpoint, and "the modal wouldn't let you" is not
 * a check. readConfig() in particular re-clamps every knob, so a hand-posted
 * `days: 999999` becomes the ceiling rather than a query that scans forever.
 */
function sanitise(raw: AlertRuleInput): AlertRuleInput | { error: string } {
  if (!isAlertKind(raw.kind)) return { error: 'Choose what to watch.' }

  const input: AlertRuleInput = {
    kind: raw.kind,
    name: String(raw.name ?? '').trim(),
    isActive: raw.isActive !== false,
    frequency: raw.frequency,
    sendTime: String(raw.sendTime ?? ''),
    daysOfWeek: String(raw.daysOfWeek ?? '1111111'),
    dayOfMonth: Number(raw.dayOfMonth) || 1,
    config: readConfig(raw.kind, JSON.stringify(raw.config ?? {})) as AlertConfig,
    notifyBell: raw.notifyBell === true,
    notifyEmail: raw.notifyEmail === true,
    notifyWhatsapp: raw.notifyWhatsapp === true,
    notifySms: raw.notifySms === true,
    recipientUserIds: toIds(raw.recipientUserIds),
    recipientEmails: toList(raw.recipientEmails),
    whatsappNumbers: toList(raw.whatsappNumbers),
    smsNumbers: toList(raw.smsNumbers),
  }

  const check = validateAlertRule(input)
  if (!check.ok) return { error: check.error }
  return input
}

function toIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
}

function toList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))]
}

export async function saveAlertAction(
  id: number | null,
  raw: AlertRuleInput,
): Promise<AlertResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor, capabilities } = ctx

  const input = sanitise(raw)
  if ('error' in input) return { ok: false, error: input.error }

  /*
   * A rule that ACTS answers to that module's capability, checked HERE as well
   * as at 07:00.
   *
   * Failing in front of the person configuring it beats a rule that looks saved
   * tonight and pauses itself tomorrow morning, when nobody is watching to find
   * out why. It also closes the obvious hole: setting up an automation to raise
   * purchase orders you are not allowed to raise yourself.
   */
  const acting = actingCapability(input)
  if (acting && !can(capabilities, acting)) {
    return {
      ok: false,
      error: 'You cannot set an alert to raise orders, because you cannot raise them yourself.',
    }
  }

  if (id === null) {
    const newId = await createRule(siteId, input, actor)

    /*
     * Burn the occurrence that has already passed.
     *
     * A rule created at 19:00 for "07:00 daily" must start tomorrow. Without
     * this the next tick finds this morning's 07:00 unclaimed and fires an
     * alert the moment it is saved — which reads as a bug even though the
     * schedule is doing exactly what it says.
     */
    const due = lastDueAt(input, new Date())
    if (due) await skipFirstOccurrence(siteId, newId, due)

    revalidatePath(PATH)
    return { ok: true, id: newId }
  }

  const existing = await getRule(siteId, id)
  if (!existing) return { ok: false, error: 'That alert no longer exists.' }

  await updateRule(siteId, id, input)
  revalidatePath(PATH)
  return { ok: true, id }
}

export async function setAlertActiveAction(id: number, active: boolean): Promise<AlertResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const existing = await getRule(ctx.siteId, id)
  if (!existing) return { ok: false, error: 'That alert no longer exists.' }

  await setRuleActive(ctx.siteId, id, active)
  revalidatePath(PATH)
  return { ok: true, id }
}

export async function deleteAlertAction(id: number): Promise<AlertResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await deleteRule(ctx.siteId, id)
  revalidatePath(PATH)
  return { ok: true }
}

/**
 * Run one rule now — "Check now".
 *
 * Runs under the RULE's owner, not the person pressing the button, exactly as
 * the 07:00 run does. Anything else would make this a way to have a check run
 * with somebody else's access, and would mean the button and the timer could
 * produce different results from the same rule.
 */
export async function runAlertNowAction(id: number): Promise<AlertResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const rule = await getRule(ctx.siteId, id)
  if (!rule) return { ok: false, error: 'That alert no longer exists.' }

  const result = await runRuleNow(ctx.siteId, rule)
  revalidatePath(PATH)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, id }
}

export type AlertRunRow = {
  dueAt: string
  status: string
  finishedAt: string | null
  itemCount: number
  createdDocs: string
  recipients: string
  attempts: number
  errorText: string
}

export async function listAlertRunsAction(
  id: number,
): Promise<{ ok: true; runs: AlertRunRow[] } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const runs = await listRuns(ctx.siteId, id, 20)
  return { ok: true, runs: runs.map(toRow) }
}

function toRow(r: AlertRun): AlertRunRow {
  return {
    // Wall clock, not toISOString() — see wallClock() below.
    dueAt: wallClock(r.dueAt) ?? '',
    status: r.status,
    finishedAt: wallClock(r.finishedAt),
    itemCount: r.itemCount,
    createdDocs: r.createdDocs,
    recipients: r.recipients,
    attempts: r.attempts,
    errorText: r.errorText,
  }
}

/**
 * A stored DATETIME as the wall clock it actually is.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of the
 * driver's Date ARE the stored wall clock. toISOString() re-stamps that wall
 * clock as UTC and the browser shifts it a second time — which turned a check
 * that ran at 01:09 into "Tomorrow 01:09" on the list before this was fixed.
 *
 * Same helper, for the same reason, as wallClock() in site/jobAppointments.ts.
 */
function wallClock(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

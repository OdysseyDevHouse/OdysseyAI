'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { PERIOD_KEYS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  setScheduleActive,
  updateSchedule,
  claimRun,
  type Frequency,
  type ScheduleInput,
} from '@/lib/site/reportSchedules'
import { runAndSend } from '@/lib/reportSchedules/send'

export type ScheduleFormValues = {
  id: number | null
  name: string
  reportId: string
  periodKey: string
  frequency: string
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

export type ActionResult = { ok: true; id?: number } | { ok: false; error: string }

/**
 * Save a schedule.
 *
 * Everything is re-validated here rather than trusted from the form: a schedule
 * runs unattended, so a bad value is not a bad screen — it is a rule that
 * either never fires or mails the wrong thing every morning until someone
 * notices.
 */
export async function saveScheduleAction(values: ScheduleFormValues): Promise<ActionResult> {
  const { siteId, actor, capabilities } = await requireCapability('reports.schedule')
  const allow = (c: Capability) => can(capabilities, c)

  const name = values.name.trim()
  if (!name) return { ok: false, error: 'Give the schedule a name.' }

  // The report must exist AND be one this person may run — otherwise scheduling
  // would be a way to have a report emailed that you cannot open yourself.
  const report = await resolveReport(siteId, values.reportId)
  if (!report) return { ok: false, error: 'That report no longer exists.' }
  if (report.permission && !allow(report.permission)) {
    return { ok: false, error: 'You do not have access to that report.' }
  }

  const frequency = (['daily', 'weekly', 'monthly'] as const).includes(values.frequency as Frequency)
    ? (values.frequency as Frequency)
    : 'daily'

  if (frequency === 'weekly' && !values.daysOfWeek.includes('1')) {
    return { ok: false, error: 'Pick at least one day of the week.' }
  }

  const emails = values.recipientEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))

  const badEmail = values.recipientEmails.find(
    (e) => e.trim() && !emails.includes(e.trim().toLowerCase()),
  )
  if (badEmail) return { ok: false, error: `“${badEmail.trim()}” is not a valid email address.` }

  if (values.recipientUserIds.length === 0 && emails.length === 0) {
    return { ok: false, error: 'Choose at least one person to send it to.' }
  }

  const input: ScheduleInput = {
    name,
    reportId: values.reportId,
    periodKey: (PERIOD_KEYS.includes(values.periodKey as PeriodKey)
      ? values.periodKey
      : 'yesterday') as PeriodKey,
    frequency,
    sendTime: /^\d{2}:\d{2}$/.test(values.sendTime) ? values.sendTime : '07:00',
    daysOfWeek: /^[01]{7}$/.test(values.daysOfWeek) ? values.daysOfWeek : '1111111',
    dayOfMonth: Math.max(1, Math.min(31, Math.round(values.dayOfMonth) || 1)),
    recipientUserIds: values.recipientUserIds.filter((n) => Number.isInteger(n) && n > 0),
    recipientEmails: emails,
    attachCsv: values.attachCsv,
    includeHtml: values.includeHtml,
    message: values.message.trim(),
    isActive: values.isActive,
  }

  try {
    if (values.id) {
      const existing = await getSchedule(siteId, values.id)
      if (!existing) return { ok: false, error: 'That schedule no longer exists.' }
      await updateSchedule(siteId, values.id, input)
      revalidatePath('/reports/schedules')
      return { ok: true, id: values.id }
    }
    const id = await createSchedule(siteId, input, actor)
    revalidatePath('/reports/schedules')
    return { ok: true, id }
  } catch {
    return { ok: false, error: 'Could not save the schedule. Try again.' }
  }
}

export async function toggleScheduleAction(id: number, active: boolean): Promise<ActionResult> {
  const { siteId } = await requireCapability('reports.schedule')
  try {
    await setScheduleActive(siteId, id, active)
    revalidatePath('/reports/schedules')
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not change that schedule. Try again.' }
  }
}

export async function deleteScheduleAction(id: number): Promise<ActionResult> {
  const { siteId } = await requireCapability('reports.schedule')
  try {
    await deleteSchedule(siteId, id)
    revalidatePath('/reports/schedules')
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not delete that schedule. Try again.' }
  }
}

/**
 * Send one now, to check it works.
 *
 * Uses a due time of NOW, which claims a ledger row of its own rather than
 * consuming the real occurrence — testing a schedule at 06:55 must not stop the
 * 07:00 send going out.
 */
export async function sendNowAction(id: number): Promise<ActionResult> {
  const { siteId } = await requireCapability('reports.schedule')

  const schedule = await getSchedule(siteId, id)
  if (!schedule) return { ok: false, error: 'That schedule no longer exists.' }

  try {
    const now = new Date()
    // Seconds are kept here (unlike a real occurrence, which zeroes them) so a
    // test send can never collide with the scheduled instant it sits next to.
    const runId = await claimRun(siteId, id, now)
    if (runId === null) return { ok: false, error: 'A send for this moment is already in flight.' }

    const outcome = await runAndSend(siteId, schedule, runId, now)
    revalidatePath('/reports/schedules')

    if (outcome.status === 'sent') {
      return { ok: true }
    }
    return {
      ok: false,
      error: outcome.status === 'skipped' ? outcome.reason : outcome.error,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The test send failed.' }
  }
}

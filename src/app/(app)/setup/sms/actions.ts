'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import { getSmsProvider } from '@/lib/site/sms'
import { normaliseSaPhone } from '@/lib/sms/phone'
import { SMS_SECRET_MASK } from '@/lib/sms/types'

/**
 * SMS settings.
 *
 * The credentials are plain settings rows — the screen says so out loud. The
 * secret round-trips MASKED: an unchanged masked value is not written, so
 * loading the page and pressing Save cannot corrupt a working secret.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveSmsSettingsAction(input: {
  provider: '' | 'log' | 'smsportal'
  clientId: string
  clientSecret: string
  statementNotify: boolean
  laybyReminderDays: number
  laybyReminderSms: string
}): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (!['', 'log', 'smsportal'].includes(input.provider)) {
    return { ok: false, error: 'That provider is not recognised.' }
  }
  if (input.provider === 'smsportal' && !input.clientId.trim()) {
    return { ok: false, error: 'SMSPortal needs the client ID from your account.' }
  }
  if (input.laybyReminderSms.length > 320) {
    return { ok: false, error: 'The reminder message is capped at 320 characters.' }
  }
  const days = Math.min(Math.max(Math.round(input.laybyReminderDays), 0), 90)

  await setSetting(siteId, 'sms_provider', input.provider)
  await setSetting(siteId, 'sms_client_id', input.clientId.trim())
  if (input.clientSecret && input.clientSecret !== SMS_SECRET_MASK) {
    await setSetting(siteId, 'sms_client_secret', input.clientSecret.trim())
  }
  await setSetting(siteId, 'statement_sms_notify', input.statementNotify ? '1' : '0')
  await setSetting(siteId, 'layby_reminder_days', String(days))
  if (input.laybyReminderSms.trim()) {
    await setSetting(siteId, 'layby_reminder_sms', input.laybyReminderSms.trim())
  }

  revalidatePath('/setup/sms')
  return { ok: true, message: 'SMS settings saved.' }
}

export async function sendTestSmsAction(to: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const provider = await getSmsProvider(siteId)
  if (!provider) return { ok: false, error: 'Save a provider first.' }

  const phone = normaliseSaPhone(to)
  if (!phone) return { ok: false, error: 'That does not look like a mobile number.' }

  const result = await provider.send(phone, 'Test message from your OdysseyAI system. SMS is working.')
  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    message:
      provider.name === 'log'
        ? `Logged to the server console (the log provider sends nothing).`
        : `Sent to ${phone}.`,
  }
}

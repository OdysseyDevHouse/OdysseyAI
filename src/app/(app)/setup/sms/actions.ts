'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSetting, setSetting } from '@/lib/site/settings'
import { getSmsProvider } from '@/lib/site/sms'
import { normaliseSaPhone } from '@/lib/sms/phone'
import { SMS_SECRET_MASK, WHATSAPP_SECRET_MASK } from '@/lib/sms/types'
import { sendWhatsAppText } from '@/lib/whatsapp'
import { isValidPhone } from '@/lib/alerts/types'

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

/**
 * WhatsApp settings, beside the SMS ones for the same reason the forms share a
 * screen: from the shop's side they are one decision.
 *
 * The token round-trips masked, exactly as the SMS secret does — an unchanged
 * mask is never written, so Save is always safe to press.
 */
export async function saveWhatsAppSettingsAction(input: {
  enabled: boolean
  phoneId: string
  token: string
}): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const phoneId = input.phoneId.trim()
  const token = input.token.trim()

  /*
   * Switching it ON requires both halves.
   *
   * A half-configured WhatsApp would look enabled on this screen and resolve to
   * "not configured" at 07:00 — so an alert would run, find things, and report
   * a channel problem nobody expected. Refusing here makes the screen tell the
   * truth about itself.
   */
  if (input.enabled) {
    if (!phoneId) return { ok: false, error: 'WhatsApp needs the phone number ID from Meta.' }
    // Blank on an ENABLED save is only acceptable when one is already stored —
    // which is exactly what the mask means.
    const stored = await getSetting(siteId, 'whatsapp_token')
    if (!token && !stored) return { ok: false, error: 'WhatsApp needs an access token.' }
  }

  await setSetting(siteId, 'whatsapp_enabled', input.enabled ? '1' : '0')
  await setSetting(siteId, 'whatsapp_phone_id', phoneId)
  if (token && token !== WHATSAPP_SECRET_MASK) {
    await setSetting(siteId, 'whatsapp_token', token)
  }

  revalidatePath('/setup/sms')
  // The alerts screen reads which channels are set up, so its callout is stale
  // the moment this changes.
  revalidatePath('/setup/alerts')
  return { ok: true, message: 'WhatsApp settings saved.' }
}

export async function sendTestWhatsAppAction(to: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (!isValidPhone(to)) return { ok: false, error: 'That does not look like a phone number.' }

  const result = await sendWhatsAppText(
    siteId,
    to,
    'Test message from your OdysseyAI system. WhatsApp is working.',
  )
  if (result.skipped === 'not-configured') {
    return { ok: false, error: 'Switch WhatsApp on and save the details first.' }
  }
  if (!result.sent) {
    return { ok: false, error: result.error ?? 'The message could not be sent.' }
  }
  return { ok: true, message: `Sent to ${result.to ?? to}.` }
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

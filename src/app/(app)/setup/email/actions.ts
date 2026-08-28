'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import { verifyMailFor } from '@/lib/mail'
import { SMTP_PASS_MASK } from './constants'

/**
 * The shop's own outgoing mail account.
 *
 * ── THE PASSWORD ROUND-TRIPS MASKED ─────────────────────────────────────────
 *
 * Exactly as `sms_client_secret` does beside it, and for the same reason: the
 * screen has to be able to show that a password IS set without showing what it
 * is, and pressing Save after merely opening the page must not overwrite a
 * working one with a row of dots. An unchanged mask is not written.
 *
 * ── AND IT IS STORED AS TYPED ───────────────────────────────────────────────
 *
 * Not encrypted. The screen says so plainly rather than implying otherwise —
 * see `smtp_pass` in settings.ts for why encrypting it here would be theatre:
 * the key would live on the same machine as the database.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

// SMTP_PASS_MASK moved to ./constants: a 'use server' module may only export
// async functions, and exporting a const here failed the whole build.

export type MailSettingsInput = {
  host: string
  port: string
  user: string
  /** The mask when unchanged, a new password otherwise, '' to clear it. */
  pass: string
  secure: boolean
  from: string
}

export async function saveMailSettingsAction(input: MailSettingsInput): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const host = input.host.trim()
  const from = input.from.trim()

  /*
   * ── BOTH OR NEITHER ─────────────────────────────────────────────────────
   *
   * A half-filled account is the one state that must not be saveable, because
   * `mailConfigFor` treats incomplete settings as "fall back to the process
   * account" — so a shop that filled in a host and forgot the From address
   * would keep sending as us and have a screen that looked configured. Saying
   * so here is the only place anybody would find out.
   *
   * Both empty is a legitimate state: it means "use the system's account", and
   * it is how a shop undoes this.
   */
  if (host && !from) {
    return { ok: false, error: 'Add the address your mail is sent from — it is what recipients reply to.' }
  }
  if (from && !host) {
    return { ok: false, error: 'Add your mail server before the From address.' }
  }

  if (from && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(from)) {
    return { ok: false, error: 'That From address does not look right.' }
  }

  const port = Number(input.port.trim() || '587')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'The port must be a whole number — 587, 465 or 25 are the usual ones.' }
  }

  await setSetting(siteId, 'smtp_host', host)
  await setSetting(siteId, 'smtp_port', String(port))
  await setSetting(siteId, 'smtp_user', input.user.trim())
  await setSetting(siteId, 'mail_from', from)
  await setSetting(siteId, 'smtp_secure', input.secure ? '1' : '0')

  /*
   * The password, and only when it actually changed.
   *
   * The mask means "leave it alone". An empty string is a real instruction —
   * somebody clearing the field to move to an unauthenticated relay — and is
   * written. Clearing the HOST clears it too: a password left behind for a
   * server the shop no longer uses is a credential nobody is thinking about.
   */
  if (!host) {
    await setSetting(siteId, 'smtp_pass', '')
  } else if (input.pass !== SMTP_PASS_MASK) {
    await setSetting(siteId, 'smtp_pass', input.pass)
  }

  /* Every screen that asks whether mail is set up before offering to send —
     the document action bar, the statement runs, the alerts. */
  revalidatePath('/', 'layout')

  return {
    ok: true,
    message: host
      ? 'Mail account saved. Send yourself a test to be sure of it.'
      : 'Mail account cleared — documents will send from the system account.',
  }
}

/**
 * Prove it works, by connecting AND by sending.
 *
 * ── WHY IT SENDS RATHER THAN ONLY CONNECTING ────────────────────────────────
 *
 * `verify()` catches the wrong host, the wrong port, a bad password and TLS the
 * wrong way round. It does not catch the failures that only appear at delivery:
 * a From address the provider will not relay for, or an account permitted to
 * connect and not to send. Those are exactly what a shop discovers on its first
 * real invoice, in front of a customer — so the test does the whole thing.
 */
export async function sendTestMailAction(to: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const address = to.trim()
  if (!address) return { ok: false, error: 'Where should the test go?' }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: 'That does not look like an email address.' }
  }

  const result = await verifyMailFor(ctx.siteId, address)
  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    message: `Sent to ${address}. If it does not arrive within a minute, check the junk folder.`,
  }
}

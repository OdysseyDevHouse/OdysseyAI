import 'server-only'
import { send as sendMail, isConfigured as mailConfigured } from '../mail'
import { normaliseSaPhone } from '../sms/phone'
import { truncateSms } from '../sms/types'
import { getSmsProvider } from '../site/sms'
import { listUsers } from '../site/users'
import { notify } from '../site/notifications'
import { sendWhatsAppText } from '../whatsapp'
import { messageText, type AlertMessage } from './message'
import { isValidEmail, type AlertRule } from './types'

/**
 * Delivering one alert across the channels its rule switched on.
 *
 * ── FAILURE SEMANTICS, CHOSEN PER CHANNEL ────────────────────────────────
 *
 * Not a uniform policy, because the channels are not uniform. The question
 * every one answers is "would retrying this whole run be an improvement?":
 *
 *   bell   — a failed insert throws, the run goes 'failed', and the tick
 *            retries. Cheap and idempotent enough: a duplicate bell row is a
 *            small annoyance, silence is the failure that matters.
 *   email  — send() reports rather than throws, so a bad address becomes a
 *            note. Only a total failure (nothing at all went out) fails the
 *            run, because retrying to reach one dead mailbox would re-send to
 *            everyone who already got it.
 *   WhatsApp
 *   SMS    — never fail the run. Both are metered and neither is idempotent:
 *            a dead token would otherwise retry the whole alert three times
 *            and bill the shop for three sends to everyone who succeeded.
 *
 * The rule throughout: a channel that is not configured is a NOTE, never an
 * error. A shop that has not set up WhatsApp has not made a mistake.
 */

export type DeliveryResult = {
  /** Everyone the alert reached, for the run ledger. */
  recipients: string[]
  /** Per-channel degradations worth showing on the rule's card. */
  notes: string[]
  /** True when a channel was switched on and nothing at all got through. */
  failed: boolean
}

export async function deliverAlert(
  siteId: number,
  rule: AlertRule,
  msg: AlertMessage,
): Promise<DeliveryResult> {
  const recipients: string[] = []
  const notes: string[] = []
  let failed = false

  // Resolved ONCE and shared by the bell and email: both need to know who is
  // still here, and asking twice invites the two channels disagreeing.
  const audience =
    rule.notifyBell || rule.notifyEmail
      ? await resolveUsers(siteId, rule.recipientUserIds)
      : { users: [], notes: [] }
  notes.push(...audience.notes)

  /* ── the bell ───────────────────────────────────────────────────────── */

  if (rule.notifyBell) {
    if (audience.users.length === 0) {
      notes.push('Nobody to notify in the app.')
    } else {
      for (const user of audience.users) {
        // userId targeting, not audience: the rule NAMES its recipients, and a
        // capability-wide row would tell the whole shop something one person
        // asked to watch.
        await notify(siteId, {
          event: 'alert_fired',
          audience: null,
          userId: user.id,
          title: msg.title,
          body: msg.summary,
          href: msg.href,
        })
        recipients.push(`${user.name} (app)`)
      }
    }
  }

  /* ── email ──────────────────────────────────────────────────────────── */

  if (rule.notifyEmail) {
    const { emails, warnings } = collectEmails(audience.users, rule.recipientEmails)
    notes.push(...warnings)

    if (emails.length === 0) {
      notes.push('No valid email address to send to.')
    } else if (!mailConfigured()) {
      notes.push('Email is not set up for this site.')
    } else {
      const text = [msg.title, '', ...msg.lines, '', msg.summary].join('\n')
      let anySent = false
      // One message per address rather than one with everybody in `to`: a shop
      // owner should not learn from an alert who else is on it, and one bad
      // address must not take the whole send down with it.
      for (const address of emails) {
        const result = await sendMail({ to: address, subject: msg.title, text, html: msg.html })
        if (result.ok) {
          anySent = true
          recipients.push(address)
        } else {
          notes.push(`Email to ${address} failed: ${result.error}`)
        }
      }
      // Only a TOTAL failure is worth retrying — see the header.
      if (!anySent) failed = true
    }
  }

  /* ── WhatsApp ───────────────────────────────────────────────────────── */

  if (rule.notifyWhatsapp && rule.whatsappNumbers.length) {
    const body = messageText(msg)
    for (const number of rule.whatsappNumbers) {
      const result = await sendWhatsAppText(siteId, number, body)
      if (result.sent) {
        recipients.push(`${result.to ?? number} (WhatsApp)`)
      } else if (result.skipped === 'not-configured') {
        // One note, not one per number: the shop has one WhatsApp setup.
        notes.push('WhatsApp is not set up for this site.')
        break
      } else {
        notes.push(`WhatsApp to ${number} failed${result.error ? `: ${result.error}` : '.'}`)
      }
    }
  }

  /* ── SMS ────────────────────────────────────────────────────────────── */

  if (rule.notifySms && rule.smsNumbers.length) {
    const provider = await getSmsProvider(siteId).catch(() => null)
    if (!provider) {
      notes.push('SMS is not set up for this site.')
    } else {
      // Fewer lines than WhatsApp: an SMS is metered per 160 characters, and
      // truncateSms would cut the summary off the end anyway.
      const body = truncateSms(messageText(msg, 4))
      for (const number of rule.smsNumbers) {
        const to = normaliseSaPhone(number)
        if (!to) {
          notes.push(`"${number}" is not a number we can text.`)
          continue
        }
        const result = await provider.send(to, body)
        if (result.ok) recipients.push(`${to} (SMS)`)
        else notes.push(`SMS to ${to} failed: ${result.error}`)
      }
    }
  }

  return { recipients, notes, failed }
}

/* ── who is still here ─────────────────────────────────────────────────────── */

type Recipient = { id: number; name: string; email: string | null }

/**
 * The named recipients who still exist and are still active.
 *
 * Re-resolved on every firing rather than trusted from the rule, which is the
 * whole reason the rule stores user ids and not addresses: somebody who changes
 * their email keeps hearing, and somebody who leaves stops — without anyone
 * remembering which alerts they were on.
 *
 * A name that has gone is a NOTE, not a failure: the other recipients should
 * still be told, and the owner should see why the list got shorter.
 */
async function resolveUsers(
  siteId: number,
  userIds: number[],
): Promise<{ users: Recipient[]; notes: string[] }> {
  if (userIds.length === 0) return { users: [], notes: [] }

  const all = await listUsers(siteId)
  const byId = new Map(all.map((u) => [u.id, u]))
  const users: Recipient[] = []
  const notes: string[] = []

  for (const id of userIds) {
    const user = byId.get(id)
    if (!user) {
      notes.push(`One recipient no longer exists and was skipped.`)
      continue
    }
    if (!user.isActive) {
      notes.push(`${user.name} no longer has access and was skipped.`)
      continue
    }
    users.push({ id: user.id, name: user.name, email: user.email })
  }

  return { users, notes }
}

/** Named users' current addresses, plus the hand-typed ones, de-duplicated. */
function collectEmails(
  users: Recipient[],
  literals: string[],
): { emails: string[]; warnings: string[] } {
  const warnings: string[] = []
  const seen = new Set<string>()
  const emails: string[] = []

  const add = (address: string | null): boolean => {
    const clean = String(address ?? '').trim()
    if (!isValidEmail(clean)) return false
    const key = clean.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      emails.push(clean)
    }
    return true
  }

  for (const user of users) {
    if (!add(user.email)) warnings.push(`${user.name} has no email address on file.`)
  }
  for (const address of literals) {
    if (!add(address)) warnings.push(`"${address}" is not a valid email address.`)
  }

  return { emails, warnings }
}

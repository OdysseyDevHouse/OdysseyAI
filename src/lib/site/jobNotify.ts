import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { getSetting, getSettings } from './settings'
import { listUsers } from './users'
import { notify } from './notifications'
import { isConfigured as mailConfigured, send as sendMail } from '../mail'
import { getSmsProvider } from './sms'
import { normaliseSaPhone } from '../sms/phone'
import { truncateSms } from '../sms/types'
import { sendWhatsAppText } from '../whatsapp'

/**
 * Telling people about a job, on whichever channel they agreed to.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * `jobPeople.mailAbout()` did this for email alone. It was right about the
 * things that are easy to get wrong — check the settings before building a
 * recipient list, never throw from inside a status change, exclude the person
 * who caused the event — and all three survive here unchanged.
 *
 * What it could not do was reach a technician who does not read email, which is
 * most of them. PRD 36 asks for five channels; the platform already had four
 * working, in `alerts/deliver.ts`, and jobs used one of them.
 *
 * ── WHY NOT JUST CALL deliverAlert() ───────────────────────────────────────
 *
 * Because it is shaped for a RULE, and a job is not one. `deliverAlert` takes an
 * `AlertRule` carrying its own recipient lists — literal phone numbers and user
 * ids typed into a setup screen by somebody who knew who should hear about it.
 *
 * A job's audience is discovered, not configured: whoever is on the job right
 * now, plus the owner, minus whoever just caused the event. And its recipients
 * are PEOPLE with consent flags, not strings. Bending one into the other would
 * mean synthesising a fake rule per notification, and the first person to add a
 * field to AlertRule would break job notifications without touching them.
 *
 * So the channel primitives are shared — the same mail sender, the same SMS
 * provider, the same WhatsApp client, the same `notify()` for the bell — and the
 * audience logic is not. What is genuinely common is the failure doctrine, and
 * that is copied deliberately and stated below.
 *
 * ── FAILURE DOCTRINE, PER CHANNEL ──────────────────────────────────────────
 *
 * Same reasoning as deliver.ts, and worth restating because it is not uniform:
 *
 *   bell   — cheap and idempotent. A duplicate row is an annoyance; silence is
 *            the failure that matters.
 *   email  — reports rather than throws. One dead mailbox is a logged failure,
 *            not a reason to abandon the other three recipients.
 *   sms
 *   whatsapp — metered and NOT idempotent. Every send is billed, so a failure is
 *            recorded and never retried from here. A shop must not be charged
 *            twice because a token expired.
 *
 * And the outer rule that outranks all of them: THIS MODULE NEVER THROWS. It
 * runs from the middle of a status change. A job that cannot be closed because
 * an SMS gateway is down is a worse outcome than a message nobody receives.
 */

type Row = RowDataPacket & Record<string, unknown>

/** The events a job can announce. Extend freely — the log column is text. */
export type NotifyEvent = 'assigned' | 'status' | 'closed'

export type NotifyChannel = 'bell' | 'email' | 'sms' | 'whatsapp' | 'push'

/** Every channel a job message can take, in the order it is attempted. */
export const JOB_CHANNELS: readonly NotifyChannel[] = ['bell', 'email', 'sms', 'whatsapp']

export type NotifyOutcome = {
  /** Messages the provider accepted, across all channels. */
  sent: number
  /** Deliberate non-sends: no consent, quiet hours, a channel switched off. */
  skipped: number
  /** Would have sent, but the same message went out inside the window. */
  suppressed: number
  /** The provider refused or errored. */
  failed: number
  /**
   * Why NOTHING went out, when nothing did. Null when at least one message was
   * attempted. Kept because the old NotifyOutcome had it and the difference
   * between "off", "nobody to tell" and "no mail server" is the first thing
   * anybody debugging this needs.
   */
  reason: 'disabled' | 'no-recipients' | null
}

const EMPTY = (reason: NotifyOutcome['reason']): NotifyOutcome => ({
  sent: 0,
  skipped: 0,
  suppressed: 0,
  failed: 0,
  reason,
})

/**
 * One person a message can reach.
 *
 * `userId` and `contactId` are mutually exclusive — staff are users, customer
 * contacts are not — and exactly one is set. The consent flags are already
 * resolved by the time a recipient exists: staff have no consent columns
 * because being told about your own work is the job, and a customer contact's
 * three flags are read from their row.
 */
export type Recipient = {
  userId: number | null
  contactId: number | null
  name: string
  email: string | null
  mobile: string | null
  consent: { email: boolean; sms: boolean; whatsapp: boolean }
}

export type JobMessage = {
  /** Subject line, and what the bell shows. */
  subject: string
  /** The body. SMS gets a truncated form of it; the bell gets a slice. */
  body: string
  /** Where the bell click goes. */
  href?: string
}

/* ── settings ─────────────────────────────────────────────────────────────── */

/**
 * Which channels this site has switched on for jobs.
 *
 * Stored as a comma list rather than a column each, matching `job_notify_events`
 * directly above it in the same settings table. A channel absent from the list
 * is off — and the DEFAULT is 'bell,email', which is what the module did before
 * SMS and WhatsApp existed here. A site that never visits the setup screen keeps
 * exactly the behaviour it had, and is not silently billed for texts.
 */
async function enabledChannels(siteId: number): Promise<Set<NotifyChannel>> {
  const raw = await getSetting(siteId, 'job_notify_channels').catch(() => '')
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (list.length === 0) return new Set<NotifyChannel>(['bell', 'email'])
  return new Set(list.filter((c): c is NotifyChannel => (JOB_CHANNELS as string[]).includes(c)))
}

/**
 * Whether right now is inside the site's quiet hours (PRD 36).
 *
 * Quiet hours suppress the METERED, INTRUSIVE channels only — SMS and WhatsApp,
 * which make a phone light up on a bedside table. The bell and email are left
 * alone deliberately: neither wakes anybody, and holding email back would mean
 * a technician's morning starts with nothing in their inbox about the job that
 * was reassigned to them overnight.
 *
 * Wraps midnight correctly, which is the whole difficulty: 21:00–06:00 is the
 * common setting and is NOT a simple `start <= now < end`. When start is after
 * end the window spans midnight and the test inverts.
 *
 * Read as WALL CLOCK. The pool runs with timezone 'Z', so a DATETIME read back
 * yields UTC parts — but quiet hours are a human setting about the local
 * evening, and the site's own clock is the honest reference for it.
 */
function insideQuietHours(from: string, to: string, now: Date): boolean {
  const parse = (v: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  const start = parse(from)
  const end = parse(to)
  // A half-configured window is not a window. Sending is the safe failure here:
  // the alternative is a typo silently muting every text the shop sends.
  if (start === null || end === null || start === end) return false

  const minutes = now.getHours() * 60 + now.getMinutes()
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

async function quietNow(siteId: number): Promise<boolean> {
  try {
    const s = await getSettings(siteId, ['job_quiet_from', 'job_quiet_to'])
    const from = s.job_quiet_from?.trim()
    const to = s.job_quiet_to?.trim()
    if (!from || !to) return false
    return insideQuietHours(from, to, new Date())
  } catch {
    return false
  }
}

/* ── the log, and the duplicate check it enables ──────────────────────────── */

type LogRow = {
  jobId: number
  event: NotifyEvent
  channel: NotifyChannel
  recipient: Recipient
  status: 'sent' | 'failed' | 'skipped' | 'suppressed'
  reason?: string
  summary: string
  destination?: string
}

async function record(siteId: number, row: LogRow): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO job_notifications
         (job_card_id, event, channel, user_id, contact_id, destination, status, reason, summary)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        row.jobId,
        row.event,
        row.channel,
        row.recipient.userId,
        row.recipient.contactId,
        (row.destination ?? '').slice(0, 190),
        row.status,
        (row.reason ?? '').slice(0, 300),
        row.summary.slice(0, 190),
      ],
    )
  } catch {
    /* The log must not be able to break the send it is describing. */
  }
}

/**
 * Has this exact message already gone to this person on this channel?
 *
 * The window is a setting because the right answer differs by shop: a busy
 * workshop moving a job through six statuses in ten minutes does not want six
 * texts, and a site that genuinely wants each one can set it to zero.
 *
 * Default 0 — OFF. Suppression that nobody asked for is indistinguishable from
 * notifications quietly breaking, and this is exactly the kind of helpfulness
 * that costs a day to diagnose. A shop turns it on when it has the problem.
 */
async function isDuplicate(
  siteId: number,
  jobId: number,
  event: NotifyEvent,
  channel: NotifyChannel,
  who: Recipient,
  windowMinutes: number,
): Promise<boolean> {
  if (windowMinutes <= 0) return false
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id FROM job_notifications
        WHERE job_card_id = ? AND event = ? AND channel = ?
          AND user_id <=> ? AND contact_id <=> ?
          AND status = 'sent'
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        LIMIT 1`,
      [jobId, event, channel, who.userId, who.contactId, windowMinutes],
      /*
       * `<=>` and not `=`. Both id columns are nullable and exactly one is set,
       * so a staff row compares contact_id NULL against NULL — which `=` answers
       * with NULL, never true, and the check would silently never match. The
       * null-safe operator is the whole reason this query works.
       */
    )
    return rows.length > 0
  } catch {
    // A table that is not there yet must not stop the message.
    return false
  }
}

/* ── the send ─────────────────────────────────────────────────────────────── */

/**
 * Tell everyone who should hear, on every channel they accept.
 *
 * Recipients are resolved by the caller, because who should hear about a job
 * differs by event and this module should not guess. `staffRecipients()` below
 * is the usual answer.
 */
export async function dispatch(
  siteId: number,
  jobId: number,
  event: NotifyEvent,
  message: JobMessage,
  recipients: readonly Recipient[],
): Promise<NotifyOutcome> {
  try {
    const on = await getSetting(siteId, 'job_notify_enabled').catch(() => '1')
    if (on === '0') return EMPTY('disabled')

    const events = await enabledEvents(siteId)
    if (!events.has(event)) return EMPTY('disabled')

    if (recipients.length === 0) return EMPTY('no-recipients')

    const channels = await enabledChannels(siteId)
    const quiet = await quietNow(siteId)
    const windowMinutes = Number(
      (await getSetting(siteId, 'job_notify_dedupe_minutes').catch(() => '0')) || '0',
    )

    const out: NotifyOutcome = { sent: 0, skipped: 0, suppressed: 0, failed: 0, reason: null }

    /* Each channel resolves its own configuration ONCE, not per recipient: a
       shop has one mail server and one SMS token, and asking per person turns
       four recipients into four provider handshakes. */
    const mailReady = channels.has('email') ? mailConfigured() : false
    const smsProvider = channels.has('sms') ? await getSmsProvider(siteId).catch(() => null) : null

    for (const who of recipients) {
      /* ── the bell ────────────────────────────────────────────────────── */
      if (channels.has('bell') && who.userId !== null) {
        if (await isDuplicate(siteId, jobId, event, 'bell', who, windowMinutes)) {
          out.suppressed++
          await record(siteId, { jobId, event, channel: 'bell', recipient: who, status: 'suppressed', reason: 'duplicate', summary: message.subject })
        } else {
          await notify(siteId, {
            event: 'job_notice',
            audience: null,
            userId: who.userId,
            title: message.subject,
            body: message.body,
            href: message.href ?? `/jobs/${jobId}`,
          })
          out.sent++
          await record(siteId, { jobId, event, channel: 'bell', recipient: who, status: 'sent', summary: message.subject })
        }
      }

      /* ── email ───────────────────────────────────────────────────────── */
      if (channels.has('email')) {
        const to = who.email?.trim()
        if (!who.consent.email) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'email', recipient: who, status: 'skipped', reason: 'no consent', summary: message.subject })
        } else if (!to) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'email', recipient: who, status: 'skipped', reason: 'no address on file', summary: message.subject })
        } else if (!mailReady) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'email', recipient: who, status: 'skipped', reason: 'no mail server is set up', summary: message.subject, destination: to })
        } else if (await isDuplicate(siteId, jobId, event, 'email', who, windowMinutes)) {
          out.suppressed++
          await record(siteId, { jobId, event, channel: 'email', recipient: who, status: 'suppressed', reason: 'duplicate', summary: message.subject, destination: to })
        } else {
          const result = await sendMail({ to, subject: message.subject, text: message.body })
          if (result.ok) out.sent++
          else out.failed++
          await record(siteId, {
            jobId, event, channel: 'email', recipient: who,
            status: result.ok ? 'sent' : 'failed',
            reason: result.ok ? '' : (result.error ?? 'send failed'),
            summary: message.subject, destination: to,
          })
        }
      }

      /* ── SMS ─────────────────────────────────────────────────────────── */
      if (channels.has('sms')) {
        const raw = who.mobile?.trim()
        const to = raw ? normaliseSaPhone(raw) : null
        if (!who.consent.sms) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'sms', recipient: who, status: 'skipped', reason: 'no consent', summary: message.subject })
        } else if (quiet) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'sms', recipient: who, status: 'skipped', reason: 'quiet hours', summary: message.subject })
        } else if (!to) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'sms', recipient: who, status: 'skipped', reason: raw ? `"${raw}" is not a number we can text` : 'no number on file', summary: message.subject })
        } else if (!smsProvider) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'sms', recipient: who, status: 'skipped', reason: 'SMS is not set up for this site', summary: message.subject, destination: to })
        } else if (await isDuplicate(siteId, jobId, event, 'sms', who, windowMinutes)) {
          out.suppressed++
          await record(siteId, { jobId, event, channel: 'sms', recipient: who, status: 'suppressed', reason: 'duplicate', summary: message.subject, destination: to })
        } else {
          const result = await provider(smsProvider, to, truncateSms(`${message.subject}. ${message.body}`))
          if (result.ok) out.sent++
          else out.failed++
          await record(siteId, {
            jobId, event, channel: 'sms', recipient: who,
            status: result.ok ? 'sent' : 'failed',
            reason: result.ok ? '' : result.error,
            summary: message.subject, destination: to,
          })
        }
      }

      /* ── WhatsApp ────────────────────────────────────────────────────── */
      if (channels.has('whatsapp')) {
        const to = who.mobile?.trim()
        if (!who.consent.whatsapp) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'whatsapp', recipient: who, status: 'skipped', reason: 'no consent', summary: message.subject })
        } else if (quiet) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'whatsapp', recipient: who, status: 'skipped', reason: 'quiet hours', summary: message.subject })
        } else if (!to) {
          out.skipped++
          await record(siteId, { jobId, event, channel: 'whatsapp', recipient: who, status: 'skipped', reason: 'no number on file', summary: message.subject })
        } else if (await isDuplicate(siteId, jobId, event, 'whatsapp', who, windowMinutes)) {
          out.suppressed++
          await record(siteId, { jobId, event, channel: 'whatsapp', recipient: who, status: 'suppressed', reason: 'duplicate', summary: message.subject, destination: to })
        } else {
          const result = await sendWhatsAppText(siteId, to, `${message.subject}\n\n${message.body}`)
          if (result.sent) out.sent++
          else if (result.skipped === 'not-configured') out.skipped++
          else out.failed++
          await record(siteId, {
            jobId, event, channel: 'whatsapp', recipient: who,
            status: result.sent ? 'sent' : result.skipped === 'not-configured' ? 'skipped' : 'failed',
            reason: result.sent ? '' : (result.skipped === 'not-configured' ? 'WhatsApp is not set up for this site' : (result.error ?? 'send failed')),
            summary: message.subject, destination: to,
          })
        }
      }
    }

    return out
  } catch {
    /*
     * The outermost guard, inherited from mailAbout and for the same reason.
     * Everything above is already defensive; this exists so that a failure
     * nobody predicted still cannot be the reason a job refuses to close.
     */
    return EMPTY(null)
  }
}

/** Narrow wrapper so a provider failure reads the same shape as mail's. */
async function provider(
  p: NonNullable<Awaited<ReturnType<typeof getSmsProvider>>>,
  to: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await p.send(to, body)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

async function enabledEvents(siteId: number): Promise<Set<string>> {
  const raw = await getSetting(siteId, 'job_notify_events').catch(() => '')
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/* ── who to tell ──────────────────────────────────────────────────────────── */

/**
 * Turn user ids into recipients.
 *
 * Staff carry no consent flags — all three read true. Being told about the work
 * you are responsible for is the job, not marketing, and a technician who could
 * opt out of assignment notices would simply not be told they had been given
 * something. What a shop CAN turn off is the channel, site-wide, which is the
 * right level for that decision.
 *
 * Inactive users are dropped here rather than at the send: somebody who has left
 * should not receive an email, and their absence from the list is also what
 * makes 'no-recipients' honest.
 */
export async function staffRecipients(
  siteId: number,
  userIds: readonly number[],
): Promise<Recipient[]> {
  if (userIds.length === 0) return []
  try {
    const wanted = new Set(userIds)
    const users = await listUsers(siteId)
    return users
      .filter((u) => wanted.has(u.id) && u.isActive)
      .map((u) => ({
        userId: u.id,
        contactId: null,
        name: u.name,
        email: u.email?.trim() || null,
        mobile: u.mobile?.trim() || null,
        consent: { email: true, sms: true, whatsapp: true },
      }))
  } catch {
    return []
  }
}

/**
 * Customer contacts who have agreed to hear about this customer's work.
 *
 * Unlike staff, every flag here is real and defaults matter — see the column
 * comments in 031. A contact with no consent on any channel is still RETURNED,
 * not filtered out: dispatch records a 'skipped — no consent' row for them, and
 * that row is the evidence that the shop's own setting is why the customer was
 * never told. Filtering here would make it look as though nobody was listed.
 */
export async function contactRecipients(
  siteId: number,
  customerId: number,
): Promise<Recipient[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, name, email, phone, consent_email, consent_sms, consent_whatsapp
         FROM customer_contacts
        WHERE customer_id = ?
        ORDER BY is_primary DESC, sort_order ASC, name ASC`,
      [customerId],
    )
    return rows.map((r) => ({
      userId: null,
      contactId: Number(r.id),
      name: String(r.name ?? ''),
      email: (String(r.email ?? '').trim() || null),
      mobile: (String(r.phone ?? '').trim() || null),
      consent: {
        email: Number(r.consent_email) === 1,
        sms: Number(r.consent_sms) === 1,
        whatsapp: Number(r.consent_whatsapp) === 1,
      },
    }))
  } catch {
    return []
  }
}

/** The job's communication history, newest first — for the job card and audit. */
export type SentNotice = {
  id: number
  event: string
  channel: NotifyChannel
  who: string
  destination: string
  status: 'sent' | 'failed' | 'skipped' | 'suppressed'
  reason: string
  summary: string
  createdAt: Date
}

export async function noticesFor(siteId: number, jobId: number): Promise<SentNotice[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT n.id, n.event, n.channel, n.destination, n.status, n.reason, n.summary, n.created_at,
              COALESCE(u.name, c.name, '') AS who
         FROM job_notifications n
         LEFT JOIN users u             ON u.id = n.user_id
         LEFT JOIN customer_contacts c ON c.id = n.contact_id
        WHERE n.job_card_id = ?
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 200`,
      [jobId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      event: String(r.event),
      channel: String(r.channel) as NotifyChannel,
      who: String(r.who ?? ''),
      destination: String(r.destination ?? ''),
      status: String(r.status) as SentNotice['status'],
      reason: String(r.reason ?? ''),
      summary: String(r.summary ?? ''),
      createdAt: r.created_at as Date,
    }))
  } catch {
    return []
  }
}

/** Exported for the tests: the wrap-midnight rule is the part worth pinning. */
export const __test = { insideQuietHours }

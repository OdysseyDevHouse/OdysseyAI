import 'server-only'
import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Sending email.
 *
 * One transport for the whole process, cached on globalThis so hot reload does
 * not leak connections — the same pattern the database pools use in db.ts.
 *
 * ── WHY IT REPORTS RATHER THAN THROWS ────────────────────────────────────
 *
 * `send` returns a result union instead of throwing. A statement run is a queue
 * of two hundred independent sends, and one bad address must mark ONE item
 * failed rather than aborting the other hundred and ninety-nine. The caller
 * records the reason against that item and moves on.
 *
 * `isConfigured` exists so a screen can say "email is not set up" before
 * someone queues a run that cannot possibly work.
 */

const globalForMail = globalThis as unknown as { odysseyMailTransport?: Transporter }

export type MailConfig = {
  host: string
  port: number
  user: string
  pass: string
  from: string
  secure: boolean
}

/** Reads SMTP settings from the environment, or null when they are incomplete. */
export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST?.trim()
  const from = process.env.MAIL_FROM?.trim()
  if (!host || !from) return null

  const port = Number(process.env.SMTP_PORT || 587)
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    user: process.env.SMTP_USER?.trim() ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from,
    // 465 is implicit TLS; 587 and 25 negotiate it with STARTTLS. Getting this
    // backwards produces a connection that hangs rather than an error.
    secure: port === 465,
  }
}

export function isConfigured(): boolean {
  return mailConfig() !== null
}

function transport(): Transporter | null {
  const config = mailConfig()
  if (!config) return null

  if (!globalForMail.odysseyMailTransport) {
    globalForMail.odysseyMailTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      // A statement run opens one connection and reuses it for every message,
      // rather than reconnecting two hundred times.
      pool: true,
      maxConnections: 3,
      // Most SMTP providers rate-limit; going slower is better than being
      // throttled halfway through a run with no way to tell which sends landed.
      maxMessages: 50,
    })
  }

  return globalForMail.odysseyMailTransport
}

export type Attachment = {
  filename: string
  content: Buffer
  contentType?: string
}

export type SendInput = {
  to: string
  subject: string
  /** Plain text. Always send one — some clients and most filters want it. */
  text: string
  html?: string
  attachments?: Attachment[]
}

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string }

export async function send(input: SendInput): Promise<SendResult> {
  const config = mailConfig()
  if (!config) {
    return { ok: false, error: 'Email is not set up — SMTP_HOST and MAIL_FROM are missing.' }
  }

  const mailer = transport()
  if (!mailer) return { ok: false, error: 'The mail transport could not be created.' }

  if (!looksLikeEmail(input.to)) {
    return { ok: false, error: `"${input.to}" does not look like an email address.` }
  }

  try {
    const info = await mailer.sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    })
    return { ok: true, messageId: String(info.messageId ?? '') }
  } catch (error) {
    // The reason goes on the queue item, so "why did this one fail" is
    // answerable months later without digging through logs.
    const message = error instanceof Error ? error.message : 'The message could not be sent.'
    return { ok: false, error: message.slice(0, 400) }
  }
}

/** Proves the settings work, for a "test email" button on a setup screen. */
export async function verifyTransport(): Promise<SendResult> {
  const mailer = transport()
  if (!mailer) return { ok: false, error: 'Email is not set up.' }

  try {
    await mailer.verify()
    return { ok: true, messageId: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The mail server refused the connection.'
    return { ok: false, error: message.slice(0, 400) }
  }
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

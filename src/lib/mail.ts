import 'server-only'
import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Sending email.
 *
 * ── ONE TRANSPORT PER SITE, NOT ONE PER PROCESS ──────────────────────────
 *
 * This file used to read SMTP_HOST out of the environment and cache a single
 * transport for the whole process. That is right for a shop running its own
 * copy on its own machine and wrong for the cloud, where one server hosts many
 * businesses: every one of them sent from the same address, and none of them
 * could configure their own. A customer's invoice arrived from us rather than
 * from them.
 *
 * So a transport is keyed by SITE, cached on globalThis exactly as the database
 * pools are in db.ts — hot reload must not leak connections, and a statement
 * run of two hundred messages must not open two hundred connections.
 *
 * ── AND THE ENVIRONMENT IS STILL THE FALLBACK ────────────────────────────
 *
 * A site with nothing configured falls back to the process settings. That keeps
 * a self-hosted install working with the .env it already has, and it is what
 * makes this safe to adopt one shop at a time rather than as a flag day.
 *
 * The no-siteId entry points (`send`, `isConfigured`) still exist and still
 * read the environment. Twenty-nine files import them; converting the ones that
 * genuinely send is worth doing, and breaking the ones that merely ask "is mail
 * set up at all" is not.
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

/**
 * Transports by cache key — 'env' for the process settings, `site:12` for a
 * shop's own. Keyed rather than singular so one server can serve many shops
 * without their mail crossing.
 */
const globalForMail = globalThis as unknown as {
  odysseyMailTransport?: Transporter
  odysseyMailTransports?: Map<string, { transport: Transporter; fingerprint: string }>
}

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

/**
 * A shop's own SMTP settings, falling back to the environment.
 *
 * ── WHY THE FALLBACK IS ALL-OR-NOTHING ───────────────────────────────────
 *
 * A site either has its own mail account or it does not. Merging — this shop's
 * host with the environment's password — produces a configuration nobody chose
 * and cannot debug, and the most likely outcome is authenticating to a
 * customer's mail server with our credentials. So a site's settings are used
 * only when they are COMPLETE, and otherwise the environment answers whole.
 *
 * `mail_from` is what a recipient sees, and it is required alongside the host
 * for the same reason MAIL_FROM is: a message from an unset address is refused
 * by most providers and silently binned by the rest.
 */
export async function mailConfigFor(siteId: number): Promise<MailConfig | null> {
  const { getSettings } = await import('./site/settings')
  const s = await getSettings(siteId, [
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_secure',
    'mail_from',
  ]).catch(() => null)

  /* A read that failed — a site mid-migration, a database that went away — is
     "not configured for this shop", not a crash. The environment answers, and
     a screen that cares says so through `isConfiguredFor`. */
  if (!s) return mailConfig()

  const host = s.smtp_host?.trim()
  const from = s.mail_from?.trim()
  if (!host || !from) return mailConfig()

  const port = Number(s.smtp_port || 587)
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    user: s.smtp_user?.trim() ?? '',
    pass: s.smtp_pass ?? '',
    from,
    /*
     * Stored rather than inferred from the port, unlike the environment reader
     * above. 465 is implicit TLS and 587 negotiates STARTTLS, which is the
     * usual arrangement — but providers exist that do neither, and a shop that
     * has to tick a box is better served than one whose connection hangs
     * because we guessed from a port number. Defaulted from the port when the
     * setting has never been written, so the guess is still the starting point.
     */
    secure: s.smtp_secure === '1' || (s.smtp_secure === '' && port === 465),
  }
}

/** Whether THIS SHOP can send mail — its own account, or the process's. */
export async function isConfiguredFor(siteId: number): Promise<boolean> {
  return (await mailConfigFor(siteId)) !== null
}

/**
 * The transport for a config, cached by key.
 *
 * ── THE FINGERPRINT IS NOT DECORATION ────────────────────────────────────
 *
 * A cached transport holds an open connection to a host with a password. When
 * a shop CHANGES its settings, a cache keyed only by site would keep sending
 * through the old server — and the person who just fixed their password would
 * watch a test email fail for a reason the screen cannot explain. So the entry
 * records what it was built from, and a change rebuilds it.
 *
 * The old transport is closed on replacement rather than dropped: nodemailer
 * pools hold sockets, and a long-lived process that leaks one per settings save
 * runs out of file handles eventually.
 */
function transportFor(key: string, config: MailConfig): Transporter {
  const cache = (globalForMail.odysseyMailTransports ??= new Map())
  /* The password is part of what identifies the connection — a shop that fixes
     a typo in it must get a new transport — and this string never leaves the
     process. */
  const fingerprint = `${config.host}|${config.port}|${config.secure}|${config.user}|${config.pass}`

  const existing = cache.get(key)
  if (existing) {
    if (existing.fingerprint === fingerprint) return existing.transport
    try {
      existing.transport.close()
    } catch {
      /* Closing a pool that is already gone is not a reason to fail a send. */
    }
  }

  const transport = nodemailer.createTransport({
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

  cache.set(key, { transport, fingerprint })
  return transport
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

/**
 * Send as THIS SHOP.
 *
 * The same function as `send` above with one difference that matters: the
 * transport and the From address come from the site's own settings, so an
 * invoice reaches a customer from the business that issued it rather than from
 * us. A site with nothing configured falls back to the process settings, which
 * is exactly what `send` did and what a self-hosted install still wants.
 */
export async function sendAs(siteId: number, input: SendInput): Promise<SendResult> {
  const config = await mailConfigFor(siteId)
  if (!config) {
    return {
      ok: false,
      error: 'Email is not set up. Add your mail account under Setup › Email.',
    }
  }

  if (!looksLikeEmail(input.to)) {
    return { ok: false, error: `"${input.to}" does not look like an email address.` }
  }

  try {
    const info = await transportFor(`site:${siteId}`, config).sendMail({
      from: config.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    })
    return { ok: true, messageId: String(info.messageId ?? '') }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The message could not be sent.'
    return { ok: false, error: message.slice(0, 400) }
  }
}

/**
 * Prove a shop's settings work, for the "send a test" button.
 *
 * ── VERIFY, THEN ACTUALLY SEND ───────────────────────────────────────────
 *
 * `verify()` opens a connection and authenticates, which catches the common
 * failures — wrong host, wrong port, wrong password, TLS the wrong way round.
 * It does NOT catch the ones that only appear at delivery: a From address the
 * provider will not relay for, or an account allowed to connect and not to
 * send. Those are precisely the failures a shop discovers on its first real
 * invoice, so the test sends a message as well when given somewhere to send it.
 */
export async function verifyMailFor(
  siteId: number,
  /** Where to send the proof. Omitted, only the connection is checked. */
  to?: string,
): Promise<SendResult> {
  const config = await mailConfigFor(siteId)
  if (!config) {
    return { ok: false, error: 'Email is not set up. Fill in your mail account and save it first.' }
  }

  try {
    await transportFor(`site:${siteId}`, config).verify()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The mail server refused the connection.'
    return { ok: false, error: message.slice(0, 400) }
  }

  if (!to) return { ok: true, messageId: '' }

  return sendAs(siteId, {
    to,
    subject: 'Test message from your point of sale',
    text:
      'This is a test message.\n\n' +
      'If you are reading it, your mail account is set up correctly and your ' +
      'invoices, statements and orders will send from this address.',
  })
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

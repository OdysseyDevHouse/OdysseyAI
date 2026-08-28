import 'server-only'
import { randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import { appBaseUrl } from '../appUrl'
import { getBooleanSetting, type SettingKey } from './settings'
import { canTakePayments } from './payments'
import type { IntentTarget } from './payments'

/**
 * The durable link a customer scans off paper, or clicks in an email.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE CALLBACK TOKEN ──────────────────────────
 *
 * The emailed pay button already carries a signed 24-hour JWT, and for an email
 * that is right: it is minted per send, and a dead link in a two-year-old inbox
 * costs nothing. Printed paper fails all three of those assumptions.
 *
 *   It outlives the token. An invoice sits on a desk for a month and a lay-by
 *   card lives in a wallet until it is paid off, so a 24-hour square is one
 *   that has never once worked by the time somebody points a phone at it.
 *
 *   It cannot be recalled. When a document is cancelled the paper is already
 *   out there, so the only place to stop the link is a row we control. A JWT is
 *   valid until it expires and nothing can be done about that.
 *
 *   It has to be SHORT. A signed token runs past 180 characters, which on a
 *   58mm thermal slip is a dense square that scans badly in shop lighting off a
 *   supermarket phone. A slug keeps the whole URL near 34.
 *
 * So the slug is the entry point a human touches, and the JWT stays where it
 * was always right — carrying the gateway's callback. See 239_pay_links.sql.
 *
 * ── A LINK IS NOT AN INTENT ───────────────────────────────────────────────
 *
 * A link is minted when a document is PRINTED; an intent is created when
 * somebody actually decides to pay. One link legitimately yields many intents —
 * a lay-by paid off in six instalments scans the same square six times — which
 * is why this table stands apart from payment_intents rather than joining it.
 *
 * ── AND IT AUTHORISES NOTHING ─────────────────────────────────────────────
 *
 * Holding a slug gets somebody a page showing what is owed and a way to pay it.
 * It cannot read a customer's other documents, their balance, or anything else
 * on the account — the same rule the landing page has always followed. It is
 * identification, never authorisation.
 */

type Row = RowDataPacket & Record<string, unknown>

/** What a link may point at. `online_order` is absent: nothing prints one. */
export type PayLinkPurpose = Exclude<IntentTarget['purpose'], 'online_order'>

export type PayLink = {
  id: number
  slug: string
  purpose: PayLinkPurpose
  targetId: number
  /** Null means "whatever is outstanding when it is scanned". */
  amountIncl: number | null
  expiresAt: Date | null
  revokedAt: Date | null
}

/**
 * The alphabet a slug is drawn from.
 *
 * Base58 — the digits and letters MINUS `0`, `O`, `I` and `l`. Those four are
 * the pairs a person mistypes when a scanner will not read the square and they
 * fall back to keying it in off the paper, which is the exact moment this has
 * to work. Dropping them costs about 2 bits per character and buys a code that
 * can be read aloud over a phone.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Twelve characters of it — about 70 bits. See newSlug. */
const SLUG_LENGTH = 12

/**
 * An unguessable slug.
 *
 * ── WHY NOT A SEQUENCE, AND WHY 70 BITS ───────────────────────────────────
 *
 * This value is the entire address of a payable thing. A sequential one would
 * let anybody walk the range and read what other people owe — every invoice,
 * every lay-by, every balance, one increment at a time. Unguessable is cheap
 * now and impossible to retrofit once the squares are printed on paper in
 * customers' hands.
 *
 * Rejection sampling rather than `% ALPHABET.length`: the modulo is biased when
 * 256 is not a multiple of the alphabet (58 does not divide it), and a biased
 * slug is a slug with fewer real bits than it appears to have. The loop costs
 * nothing at this size and the reasoning does not have to be revisited.
 */
function newSlug(): string {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length
  let out = ''
  while (out.length < SLUG_LENGTH) {
    for (const byte of randomBytes(SLUG_LENGTH)) {
      if (byte >= max) continue
      out += ALPHABET[byte % ALPHABET.length]
      if (out.length === SLUG_LENGTH) break
    }
  }
  return out
}

/** Which setting governs each kind of link. */
const SETTING_FOR: Record<PayLinkPurpose, SettingKey> = {
  debtor_invoice: 'pay_link_on_invoices',
  customer_account: 'pay_link_on_statements',
  layby: 'pay_link_on_laybys',
  job_deposit: 'pay_link_on_quotes',
  document_deposit: 'pay_link_on_quotes',
}

/**
 * How long a printed link stands, by kind.
 *
 * Long, because paper is patient — but never open-ended. A link on a document
 * settled three years ago is a surface with no reason to exist, and the cost of
 * an expiry is only that somebody with very old paper has to phone, which they
 * were going to do anyway.
 */
const LIFETIME_DAYS: Record<PayLinkPurpose, number> = {
  // An invoice is chased for months and then written off.
  debtor_invoice: 365,
  // A statement is superseded by next month's, but the balance persists.
  customer_account: 365,
  // layby_default_days is 90 and extensions are ordinary. Well clear of both.
  layby: 545,
  job_deposit: 365,
  document_deposit: 365,
}

/**
 * Is this shop willing and able to be paid this way right now?
 *
 * BOTH halves, and the second is the one that matters. The setting is what the
 * owner asked for; `canTakePayments` is whether the gateway is actually live
 * and its credentials decrypt. A shop that switched the setting on and later
 * had its ENCRYPTION_KEY change would otherwise print squares that lead to a
 * page apologising — on paper, which cannot be corrected.
 */
export async function payLinksEnabled(
  siteId: number,
  purpose: PayLinkPurpose,
): Promise<boolean> {
  if (!(await getBooleanSetting(siteId, SETTING_FOR[purpose]))) return false
  return canTakePayments(siteId)
}

function mapLink(r: Row): PayLink {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    purpose: String(r.purpose) as PayLinkPurpose,
    targetId: Number(r.target_id),
    amountIncl: r.amount_incl === null ? null : toNum(r.amount_incl),
    expiresAt: (r.expires_at as Date | null) ?? null,
    revokedAt: (r.revoked_at as Date | null) ?? null,
  }
}

/**
 * The link for a thing, made once and reused.
 *
 * ── WHY A REPRINT MUST NOT MINT A SECOND ONE ──────────────────────────────
 *
 * An invoice gets reprinted — the first copy was lost, the printer jammed, the
 * customer asked for another. If each print minted a fresh slug the shop would
 * be scattering live links for one debt, every one of them payable, and
 * revoking the document would mean finding all of them. So this is get-or-
 * create against the live row, and a reprint carries the square it had.
 *
 * A REVOKED or EXPIRED link is deliberately not reused: those are dead by
 * intent, and handing the same slug back would resurrect something that was
 * stopped on purpose. A new one is minted instead, which is right — the paper
 * being printed now is new paper.
 *
 * Returns null rather than throwing when links are switched off or the gateway
 * cannot take money. Every caller is a print or a send, and none of them should
 * fail over a missing QR: a document with no square is still a document.
 */
export async function payLinkFor(
  siteId: number,
  purpose: PayLinkPurpose,
  targetId: number,
  opts: { amountIncl?: number | null; createdBy?: string } = {},
): Promise<PayLink | null> {
  if (!(await payLinksEnabled(siteId, purpose))) return null

  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM pay_links
      WHERE purpose = ? AND target_id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY id DESC LIMIT 1`,
    [purpose, targetId],
  )
  if (existing) return mapLink(existing)

  const slug = newSlug()
  await siteExecute(
    siteId,
    `INSERT INTO pay_links (slug, purpose, target_id, amount_incl, expires_at, created_by)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
    [
      slug,
      purpose,
      targetId,
      opts.amountIncl == null ? null : opts.amountIncl.toFixed(4),
      LIFETIME_DAYS[purpose],
      (opts.createdBy ?? '').slice(0, 120),
    ],
  )

  const row = await siteQueryOne<Row>(siteId, `SELECT * FROM pay_links WHERE slug = ?`, [slug])
  return row ? mapLink(row) : null
}

/**
 * The absolute URL to print or send, or null.
 *
 * Null when APP_URL is unset, and that is the whole reason this is not built by
 * hand at each call site. A localhost URL printed on a customer's invoice is
 * permanent and useless; qrLinks.ts refuses one for the same reason, and this
 * agrees with it rather than inventing a host.
 *
 * ── THE SITE IS IN THE SLUG, NOT A SECOND PATH SEGMENT ────────────────────
 *
 * Pay links live in each shop's OWN database, so a slug carrying nothing would
 * have to be looked for in every one of them — unbounded work driven by an
 * unauthenticated request, which is a denial of service with a friendly URL. It
 * is the same problem callbackToken.ts solves for the gateway callback, and the
 * site has to be established BEFORE the lookup, not by it.
 *
 * The obvious fix is the portal token in the path, as /store/ and /reserve/ do.
 * MEASURED, that gives a 149-character URL against 41 for the slug alone,
 * because the token is 107 characters on its own. That is precisely the density
 * this whole design exists to avoid: a dense square on a 58mm thermal slip,
 * scanned in shop lighting off whatever phone the customer happens to have.
 *
 * So the site rides INSIDE the slug as a short prefix — `<site36>-<random>`.
 * One indexed read in one named database, no fan-out, and the URL stays short
 * enough to print and to read aloud over a phone.
 *
 * The prefix is not a secret and does not need to be: it names a shop, which is
 * public the moment its name is on the paper. What must stay unguessable is
 * WHICH DEBT, and that is the random half, which is untouched.
 */
export async function payLinkUrl(
  siteId: number,
  purpose: PayLinkPurpose,
  targetId: number,
  opts: { amountIncl?: number | null; createdBy?: string } = {},
): Promise<string | null> {
  const base = appBaseUrl()
  if (!base) return null

  const link = await payLinkFor(siteId, purpose, targetId, opts)
  if (!link) return null

  return `${base.replace(/\/$/, '')}/p/${siteId.toString(36)}-${link.slug}`
}

/**
 * Split a scanned code back into the site that owns it and its slug.
 *
 * Null for anything malformed, so the route can 404 without a second thought.
 * Note this only says which database to LOOK IN — the slug still has to be
 * found there, and a prefix naming a real site with a slug that is not in it
 * resolves to nothing.
 */
export function splitPayCode(code: string): { siteId: number; slug: string } | null {
  const at = code.indexOf('-')
  if (at <= 0) return null

  const siteId = parseInt(code.slice(0, at), 36)
  const slug = code.slice(at + 1)
  if (!Number.isInteger(siteId) || siteId <= 0) return null
  if (!slug || slug.length > 24) return null

  return { siteId, slug }
}

/**
 * Resolve a scanned slug, or null.
 *
 * Null for every kind of failure — unknown, revoked, expired, malformed — and
 * the route turns all of them into one 404. Distinguishing them would make this
 * an oracle for which slugs exist, and the slug IS the address of somebody's
 * debt.
 */
export async function resolvePayLink(siteId: number, slug: string): Promise<PayLink | null> {
  if (!slug || slug.length > 24) return null

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM pay_links
      WHERE slug = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [slug],
  )
  return row ? mapLink(row) : null
}

/**
 * What a scanned link is asking for, in the payer's words.
 *
 * ── WHAT THIS MAY SAY, AND WHY IT IS SO LITTLE ────────────────────────────
 *
 * Anyone holding the code can open it. It is printed on paper that gets left on
 * desks, photographed and forwarded, so this returns only what somebody needs
 * in order to pay with confidence: what it is for, and how much.
 *
 * No line detail, no account history, no other documents, no contact details.
 * The link is identification, never authorisation — the same rule the emailed
 * pay page has always followed.
 *
 * ── THE AMOUNT IS READ NOW, NOT WHEN IT WAS PRINTED ───────────────────────
 *
 * Every one of these reads what is outstanding TODAY. An invoice part-paid by
 * EFT last week, a lay-by three instalments in, a statement paid down since it
 * was posted — all of them must ask for what is left, not what the paper said.
 * A link that keeps demanding the original figure is one that takes money the
 * customer does not owe, and that is a refund and a phone call.
 *
 * Returns null when there is nothing to pay or the thing is gone, which the
 * route turns into an honest "nothing outstanding" rather than a form.
 */
export type PayableSummary = {
  /** "Invoice INV-1041", "Lay-by LAY-88", "Account 12 Main Street". */
  title: string
  /** A single line of context, or null. Never anything private. */
  subtitle: string | null
  outstanding: number
}

/**
 * Stop every link to a thing.
 *
 * Called when a document is cancelled or voided. This is the column the table
 * exists for: the paper is already in somebody's hand and cannot be recalled,
 * so the row is the only place the link can be stopped.
 *
 * Deliberately does NOT touch payment_intents. An intent already settled is
 * money that genuinely arrived, and a cancellation upstream is a refund
 * decision for a person — not something to erase by unwinding the record.
 */
export async function revokePayLinks(
  siteId: number,
  purpose: PayLinkPurpose,
  targetId: number,
): Promise<number> {
  const result = await siteExecute(
    siteId,
    `UPDATE pay_links SET revoked_at = NOW()
      WHERE purpose = ? AND target_id = ? AND revoked_at IS NULL`,
    [purpose, targetId],
  )
  return result.affectedRows ?? 0
}

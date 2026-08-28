import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { customerExecute, customerQuery, customerQueryOne } from './customerDb'
import { getSetting } from './settings'
import { sendAs, isConfiguredFor } from '../mail'

/**
 * Signing a customer in to the portal, with a link instead of a password.
 *
 * ── WHY A LINK AND NOT A PASSWORD ──────────────────────────────────────────
 *
 * customerAuth.ts already does passwords, and does them well. This is a
 * deliberate choice not to use it: a customer visits the portal perhaps twice a
 * year, and a password used twice a year is a password that gets reset twice a
 * year — or written down. There is nothing to leak here because there is nothing
 * stored.
 *
 * The cost is honest and worth stating plainly: a customer whose email address
 * is wrong, bounced or mistyped has NO way in at all, and no password to fall
 * back on. That is a support burden this design accepts.
 *
 * ── WHAT MAKES A LINK SAFE ─────────────────────────────────────────────────
 *
 *   32 random bytes, so there is nothing to guess
 *   stored HASHED, so a database copy is not a set of keys
 *   SINGLE USE, so a forwarded email stops working once somebody clicks it
 *   short-lived, so an unclicked one lapses
 *   consumed BEFORE the session is minted, so two simultaneous clicks
 *     cannot both succeed
 *
 * ── IT NEVER SAYS WHETHER AN EMAIL IS KNOWN ────────────────────────────────
 *
 * requestLink returns the same answer for a customer, a stranger and a
 * misspelling. Otherwise the form is a way to ask "is this person a customer of
 * yours", which is a question the business has not agreed to answer.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Long enough to find the email, short enough that an old one is dead. */
const LINK_MINUTES = 30

/** How many links one customer may ask for in an hour. */
const MAX_LINKS_PER_HOUR = 5

export type PortalSettings = {
  isEnabled: boolean
  allowComments: boolean
  allowUploads: boolean
  allowQuoteAccept: boolean
  maxUploadsPerJob: number
}

/** How the portal is configured. Fails CLOSED on any error. */
export async function portalSettings(siteId: number): Promise<PortalSettings> {
  const closed: PortalSettings = {
    isEnabled: false,
    allowComments: false,
    allowUploads: false,
    allowQuoteAccept: false,
    maxUploadsPerJob: 0,
  }
  try {
    const [enabled, comments, uploads, quotes, maxUploads] = await Promise.all([
      getSetting(siteId, 'portal_enabled'),
      getSetting(siteId, 'portal_allow_comments'),
      getSetting(siteId, 'portal_allow_uploads'),
      getSetting(siteId, 'portal_allow_quote_accept'),
      getSetting(siteId, 'portal_max_uploads_per_job'),
    ])
    if (enabled !== '1') return closed
    return {
      isEnabled: true,
      allowComments: comments === '1',
      allowUploads: uploads === '1',
      allowQuoteAccept: quotes === '1',
      maxUploadsPerJob: Math.max(0, Math.min(100, Number(maxUploads) || 0)),
    }
  } catch {
    // A site without 130 has no portal, which is the safe answer.
    return closed
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Send a sign-in link to a customer.
 *
 * ── ALWAYS RETURNS THE SAME THING ──────────────────────────────────────────
 *
 * Whether the address belongs to a customer, whether mail is configured,
 * whether the send worked — the caller gets `{ sent: true }` regardless. The
 * reason is above: this form must not be usable to discover who is a customer.
 *
 * The one thing it does NOT do is pretend when the portal is switched off, since
 * that is a fact about the business rather than about any person.
 */
export async function requestLink(
  siteId: number,
  emailRaw: string,
  opts: { ip?: string | null; baseUrl?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const settings = await portalSettings(siteId)
  if (!settings.isEnabled) {
    return { ok: false, error: 'This business does not offer an online account.' }
  }

  const email = emailRaw.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'That does not look like an email address.' }
  }

  try {
    /*
     * Matched against the CUSTOMER record, not customer_logins.
     *
     * A portal sign-in needs no password row to exist, so a customer who has
     * never used the storefront can still be sent a link.
     *
     * ON HOLD still gets in, deliberately: an account on hold is a money
     * dispute, and the customer needs to SEE the invoices being disputed more
     * than ever. Closed and inactive do not — those accounts are over.
     */
    const customer = await customerQueryOne<Row>(
      siteId,
      `SELECT id, name, email FROM customers
        WHERE LOWER(email) = ? AND status IN ('active', 'on_hold')
        LIMIT 1`,
      [email],
    )

    // Everything below is best-effort and silent. See the header.
    if (customer) {
      const customerId = Number(customer.id)

      // The rate check. A stranger cannot trigger it, because a stranger has no
      // customer row — which is also why it is per customer rather than per IP.
      const recent = await customerQueryOne<Row>(
        siteId,
        `SELECT COUNT(*) AS n FROM customer_login_links
          WHERE customer_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [customerId],
      )
      if (Number(recent?.n ?? 0) < MAX_LINKS_PER_HOUR) {
        const token = randomBytes(32).toString('base64url')
        await customerExecute(
          siteId,
          `INSERT INTO customer_login_links
             (customer_id, token_hash, expires_at, requested_ip)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
          [customerId, hashToken(token), LINK_MINUTES, opts.ip ?? null],
        )

        if (await isConfiguredFor(siteId)) {
          const base = opts.baseUrl ?? process.env.APP_URL ?? ''
          await sendAs(siteId, {
            to: String(customer.email),
            subject: 'Your sign-in link',
            text:
              `Here is your link to sign in and see your jobs:\n\n` +
              `${base}/portal/enter/${token}\n\n` +
              `It works once and lasts ${LINK_MINUTES} minutes. ` +
              `If you did not ask for it, you can ignore this email.`,
          }).catch(() => undefined)
        }
      }
    }

    return { ok: true }
  } catch {
    // Even a database failure answers the same way, so the form cannot be used
    // to probe which addresses exist.
    return { ok: true }
  }
}

export type LinkClaim = { customerId: number; customerName: string }

/**
 * Spend a sign-in link.
 *
 * ── CONSUMED BEFORE ANYTHING ELSE HAPPENS ──────────────────────────────────
 *
 * The UPDATE that stamps used_at carries `used_at IS NULL` in its WHERE, so the
 * database decides who won. Two clicks arriving together produce one
 * affectedRows of 1 and one of 0, and only the first gets a session — which a
 * read-then-write could not guarantee.
 */
export async function consumeLink(
  siteId: number,
  token: string,
  ip: string | null,
): Promise<LinkClaim | null> {
  try {
    const hash = hashToken(token)

    const claimed = await customerExecute(
      siteId,
      `UPDATE customer_login_links
          SET used_at = NOW(), used_ip = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
      [ip, hash],
    )
    if (claimed.affectedRows === 0) return null

    const row = await customerQueryOne<Row>(
      siteId,
      `SELECT l.customer_id, c.name, c.status
         FROM customer_login_links l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.token_hash = ?`,
      [hash],
    )
    /*
     * The account could have been closed between the link being sent and used.
     *
     * Re-checked HERE and not only when the link was minted, because a link
     * lives half an hour and an account can be closed inside one — the session
     * about to be handed out would then outlive the account by two weeks.
     */
    if (!row || !['active', 'on_hold'].includes(String(row.status))) return null

    return { customerId: Number(row.customer_id), customerName: String(row.name ?? '') }
  } catch {
    return null
  }
}

/**
 * Remove links that are spent or lapsed.
 *
 * Housekeeping rather than security — a used link is already dead — but a table
 * that only ever grows is a table somebody eventually has to explain. Called
 * from the same cron that runs the job automations.
 */
export async function purgeOldLinks(siteId: number): Promise<number> {
  try {
    const result = await customerExecute(
      siteId,
      `DELETE FROM customer_login_links
        WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    )
    return result.affectedRows
  } catch {
    return 0
  }
}

export type PortalDrift = {
  /**
   * A live link that was never used, older than an hour.
   *
   * Not a fault on its own — people ignore emails — but a lot of them means the
   * mail is not arriving, which otherwise looks exactly like customers not
   * being interested.
   */
  unusedLinks: number
  /** Links that were used more than once. Should be impossible. */
  reusedLinks: { id: number; customerId: number }[]
}

/** Reports, never repairs. */
export async function reconcilePortal(siteId: number): Promise<PortalDrift> {
  const empty: PortalDrift = { unusedLinks: 0, reusedLinks: [] }
  try {
    const unused = await customerQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM customer_login_links
        WHERE used_at IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    )
    /*
     * Two rows sharing a hash.
     *
     * The unique key makes this impossible, and that is the point of checking:
     * if it ever returns a row, the constraint is gone and one link resolves to
     * two customers. There is no more serious drift in this module.
     */
    const reused = await customerQuery<Row>(
      siteId,
      `SELECT id, customer_id FROM customer_login_links
        WHERE token_hash IN (
          SELECT token_hash FROM (
            SELECT token_hash FROM customer_login_links
             GROUP BY token_hash HAVING COUNT(*) > 1
          ) dup
        ) LIMIT 50`,
    )
    return {
      unusedLinks: Number(unused?.n ?? 0),
      reusedLinks: reused.map((r) => ({
        id: Number(r.id),
        customerId: Number(r.customer_id),
      })),
    }
  } catch {
    return empty
  }
}

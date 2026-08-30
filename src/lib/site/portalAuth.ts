import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { customerExecute, customerQuery, customerQueryOne } from './customerDb'
import { getSetting } from './settings'
import { sendAs, isConfiguredFor } from '../mail'
import { createPortalToken } from '../publicPortalToken'
import { publicSiteName } from '../sites'
import { logActivity } from './activityLog'

/*
 * Four replaces, copied rather than imported.
 *
 * invoiceEmail exports the same function, but importing it here would pull the
 * PDF renderer, the payments gateway and the document builder into the
 * SIGN-IN path — a module chain that has no business loading so somebody can
 * ask for a link. The duplication is two lines; the coupling would not be.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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
  /** The JOBS side: a customer following their own work. */
  isEnabled: boolean
  allowComments: boolean
  allowUploads: boolean
  allowQuoteAccept: boolean
  maxUploadsPerJob: number
  /**
   * The ACCOUNT side: profile, transactions, statement.
   *
   * Independent of `isEnabled` — see the setting's own note. A shop may run
   * either, both or neither, and the guard below opens the door when EITHER is
   * on rather than treating the jobs portal as the portal.
   */
  accountsEnabled: boolean
  showTransactions: boolean
  showStatement: boolean
  allowPay: boolean
}

const CLOSED: PortalSettings = {
  isEnabled: false,
  allowComments: false,
  allowUploads: false,
  allowQuoteAccept: false,
  maxUploadsPerJob: 0,
  accountsEnabled: false,
  showTransactions: false,
  showStatement: false,
  allowPay: false,
}

/**
 * How the portal is configured. Fails CLOSED on any error.
 *
 * The two halves are resolved SEPARATELY. An earlier shape returned `closed`
 * whole the moment `portal_enabled` was off, which would have meant a shop
 * offering statements and no job cards got nothing — the jobs switch silently
 * governing a feature that has nothing to do with jobs.
 */
export async function portalSettings(siteId: number): Promise<PortalSettings> {
  try {
    const [enabled, comments, uploads, quotes, maxUploads, accounts, transactions, statement, pay] =
      await Promise.all([
        getSetting(siteId, 'portal_enabled'),
        getSetting(siteId, 'portal_allow_comments'),
        getSetting(siteId, 'portal_allow_uploads'),
        getSetting(siteId, 'portal_allow_quote_accept'),
        getSetting(siteId, 'portal_max_uploads_per_job'),
        getSetting(siteId, 'portal_accounts_enabled'),
        getSetting(siteId, 'portal_show_transactions'),
        getSetting(siteId, 'portal_show_statement'),
        getSetting(siteId, 'portal_allow_pay'),
      ])

    const jobsOn = enabled === '1'
    const accountsOn = accounts === '1'

    return {
      isEnabled: jobsOn,
      allowComments: jobsOn && comments === '1',
      allowUploads: jobsOn && uploads === '1',
      allowQuoteAccept: jobsOn && quotes === '1',
      maxUploadsPerJob: jobsOn ? Math.max(0, Math.min(100, Number(maxUploads) || 0)) : 0,
      accountsEnabled: accountsOn,
      showTransactions: accountsOn && transactions === '1',
      showStatement: accountsOn && statement === '1',
      allowPay: accountsOn && pay === '1',
    }
  } catch {
    // A site without 130 has no portal, which is the safe answer.
    return CLOSED
  }
}

/**
 * Whether the portal opens at all — either half being on is enough.
 *
 * The one question the door asks. Kept here rather than spelled out at each
 * call site so a third section added later cannot be forgotten by one of them.
 */
export function portalIsOpen(settings: PortalSettings): boolean {
  return settings.isEnabled || settings.accountsEnabled
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
  if (!portalIsOpen(settings)) {
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
          /*
           * ── THE SITE TOKEN HAS TO BE IN THE PATH ───────────────────────────
           *
           * This used to mail `/portal/enter/<token>`, and there has never been
           * a route at that address: the handler is `/portal/[token]/enter/
           * [link]`, because every page under the portal needs to know WHICH
           * BUSINESS it belongs to before it can do anything — see
           * publicPortalToken. Every sign-in email sent was a dead link, and it
           * failed silently because the send is best-effort and nothing here
           * reads the URL back.
           *
           * Minted rather than passed in: requestLink is called from a server
           * action that has the site id and not the token, and deriving it here
           * means the email and the route cannot disagree about the shape.
           */
          const siteToken = await createPortalToken(siteId)
          const url = `${base}/portal/${siteToken}/enter/${token}`
          // Tolerant AND non-null: an unnamed site drops the wording that uses
          // it rather than mailing "Sign in to your account with null".
          const siteName = (await publicSiteName(siteId).catch(() => '')) ?? ''
          const who = String(customer.name ?? '').trim()

          /*
           * ── IT IS SHAPED LIKE THE INVOICE EMAIL, AND THAT IS THE FIX ──────
           *
           * This used to send text/plain whose entire body was a greeting-less
           * sentence and a bare 200-character URL ending in 43 random
           * characters. An invoice from the same server, to the same address,
           * arrived; this did not — because that shape is a near-perfect match
           * for a phishing template, and filters score it accordingly.
           *
           * So it now carries what every other message this system sends
           * carries: a subject naming the business, a greeting to a named
           * person, an HTML part with a real anchor, and a sign-off. The plain
           * part is kept in step for clients that will not render HTML — a
           * message with no text//alternative is itself a spam signal.
           *
           * The URL stays visible in the text part on purpose. A link a person
           * can read and paste is one they can check before clicking, and it is
           * the only thing that still works when the button does not render.
           */
          const from = siteName ? ` from ${siteName}` : ''
          const result = await sendAs(siteId, {
            to: String(customer.email),
            subject: siteName ? `Sign in to your account with ${siteName}` : 'Sign in to your account',
            text:
              `Good day${who ? ` ${who}` : ''},\n\n` +
              `Here is your link to sign in and see your account${from}:\n\n` +
              `${url}\n\n` +
              `It works once and lasts ${LINK_MINUTES} minutes.\n\n` +
              `If you did not ask for it, you can ignore this email.\n\n` +
              (siteName ? `Kind regards,\n${siteName}` : ''),
            html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#16191d;line-height:1.5">
  <p>Good day${who ? ` ${escapeHtml(who)}` : ''},</p>
  <p>Here is your link to sign in and see your account${from ? ` from ${escapeHtml(siteName)}` : ''}.</p>
  <p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#16191d;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Sign in to your account</a></p>
  <p style="color:#667085;font-size:13px">It works once and lasts ${LINK_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>
  ${siteName ? `<p>Kind regards,<br>${escapeHtml(siteName)}</p>` : ''}
</div>`,
          })

          /*
           * ── A FAILED SEND IS RECORDED, NEVER RETURNED ─────────────────────
           *
           * sendAs answers with {ok:false, error} rather than throwing, and
           * this call used to discard the result entirely — so a genuine
           * failure left no trace anywhere, and the shop had no way to tell
           * "we sent it, check your spam" from "it never left the building".
           *
           * The CUSTOMER is still told nothing: the anti-enumeration rule at
           * the top of this file is not negotiable, and the caller's answer is
           * unchanged. This writes to the activity log, which only staff read.
           *
           * Logged against the customer, so it surfaces on the timeline of the
           * person who did not get their link — which is where somebody
           * investigating "they say it never arrived" will actually look.
           */
          if (!result.ok) {
            await logActivity(
              siteId,
              { userId: 0, userName: 'Customer portal' },
              {
                entity: 'customer',
                entityId: customerId,
                action: 'portal_link_failed',
                // The address and the reason. No token — an activity log is
                // read by more people than the mailbox is, and a sign-in link
                // in one would be a credential sitting in a report.
                detail: `Sign-in link to ${String(customer.email)} could not be sent — ${result.error}`,
              },
            ).catch(() => undefined)
          }
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

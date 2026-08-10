import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery } from '../siteDb'

/**
 * People who asked the shop to email them.
 *
 * See 071 on why this is its own table rather than a flag on `customers`, and
 * on why consent is recorded as evidence rather than as a boolean.
 */

type Row = RowDataPacket & Record<string, unknown>

export type Subscriber = {
  id: number
  email: string
  name: string
  consentedAt: Date
  consentText: string
  sourcePage: string
  unsubscribedAt: Date | null
}

export type SubscribeResult = { ok: true } | { ok: false; error: string }

/**
 * An address we are willing to store.
 *
 * Lowercased and trimmed, because the unique key is what stops a shop emailing
 * the same person twice and 'Sam@x.com' and 'sam@x.com' are the same person.
 *
 * The shape check is deliberately loose — one @, something either side, a dot
 * in the domain. Strict RFC validation rejects addresses that genuinely work,
 * and the only real test of an address is whether mail to it arrives.
 */
export function safeEmail(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().slice(0, 190)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : ''
}

/**
 * Sign somebody up.
 *
 * ── A SECOND SIGN-UP IS NOT AN ERROR ─────────────────────────────────────
 *
 * Somebody who already subscribed and types their address again has done
 * nothing wrong, and telling them "you are already on the list" leaks who is
 * on it to anybody who cares to probe. So a repeat is an UPDATE that refreshes
 * the consent record, and the caller says the same friendly thing either way.
 *
 * Re-subscribing also clears `unsubscribed_at` — somebody who opted out and
 * came back has opted back in, and that is the whole point of asking.
 */
export async function subscribe(
  siteId: number,
  input: { email: unknown; name?: unknown; consentText?: string; sourcePage?: string },
): Promise<SubscribeResult> {
  const email = safeEmail(input.email)
  if (!email) return { ok: false, error: 'That does not look like an email address.' }

  const name = String(input.name ?? '').trim().slice(0, 120)
  const consentText = String(input.consentText ?? '').slice(0, 300)
  const sourcePage = String(input.sourcePage ?? '').slice(0, 60)

  await siteExecute(
    siteId,
    `INSERT INTO storefront_subscribers (email, name, consent_text, source_page)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       -- The name only if they gave one this time: a blank second sign-up must
       -- not wipe a name they gave the first time.
       name = IF(VALUES(name) = '', name, VALUES(name)),
       -- Consent is re-recorded, because this IS a fresh act of consenting and
       -- the wording may have changed since.
       consented_at = CURRENT_TIMESTAMP,
       consent_text = VALUES(consent_text),
       source_page = VALUES(source_page),
       unsubscribed_at = NULL`,
    [email, name, consentText, sourcePage],
  )
  return { ok: true }
}

/** Everyone still subscribed, newest first — what a shop exports. */
export async function listSubscribers(
  siteId: number,
  includeUnsubscribed = false,
): Promise<Subscriber[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM storefront_subscribers
      ${includeUnsubscribed ? '' : 'WHERE unsubscribed_at IS NULL'}
      ORDER BY created_at DESC, id DESC`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
    name: String(r.name ?? ''),
    consentedAt: r.consented_at instanceof Date ? r.consented_at : new Date(0),
    consentText: String(r.consent_text ?? ''),
    sourcePage: String(r.source_page ?? ''),
    unsubscribedAt: r.unsubscribed_at instanceof Date ? r.unsubscribed_at : null,
  }))
}

/** How many are on the list — for the section's own summary in the builder. */
export async function subscriberCount(siteId: number): Promise<number> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM storefront_subscribers WHERE unsubscribed_at IS NULL`,
  )
  return Number(rows[0]?.n ?? 0)
}

/** Take somebody off the list, keeping the row. See 071. */
export async function unsubscribe(siteId: number, email: unknown): Promise<SubscribeResult> {
  const clean = safeEmail(email)
  if (!clean) return { ok: false, error: 'That does not look like an email address.' }
  await siteExecute(
    siteId,
    `UPDATE storefront_subscribers SET unsubscribed_at = CURRENT_TIMESTAMP WHERE email = ?`,
    [clean],
  )
  return { ok: true }
}

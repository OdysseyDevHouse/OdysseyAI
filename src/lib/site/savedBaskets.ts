import 'server-only'
import { randomBytes } from 'node:crypto'
import { siteQuery, siteQueryOne, siteExecute } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'

/**
 * Baskets a shopper asked us to keep, and the one reminder about each.
 *
 * ── CAPTURE IS ALWAYS DELIBERATE ─────────────────────────────────────────
 *
 * A row exists only because someone typed an address into a box that says "save
 * my basket", or was already signed in. There is no capture from browsing, no
 * cookie-keyed shadow profile, and nothing written on the way into checkout.
 * A shop that emails people who never asked gets marked as spam, deservedly.
 *
 * ── ONE REMINDER, EVER ───────────────────────────────────────────────────
 *
 * `reminded_at` is the guard. Not a counter, because there is no second
 * reminder to count — a sequence of "did you forget?" emails is what turns a
 * useful nudge into the reason somebody unsubscribes from a shop they liked.
 *
 * ── THE BASKET IS A MEMO, NOT A DOCUMENT ─────────────────────────────────
 *
 * It holds product ids and quantities. Nothing here is priced, reserved or
 * posted, and the stored subtotal is for the shop's reporting and the email's
 * wording only. Recovery re-reads the catalogue, exactly as checkout does, so
 * a price that moved or a product that was archived is handled at the moment
 * it matters rather than trusted from a row written days ago.
 */

type Row = Record<string, unknown>

export type SavedBasketLine = { productId: number; qty: number }

export type SavedBasket = {
  id: number
  contactEmail: string
  contactName: string
  customerId: number | null
  lines: SavedBasketLine[]
  subtotalIncl: number
  recoveryToken: string
  remindedAt: Date | null
  recoveredAt: Date | null
  orderedAt: Date | null
  unsubscribed: boolean
  updatedAt: Date | null
}

function mapBasket(r: Row): SavedBasket {
  return {
    id: Number(r.id),
    contactEmail: String(r.contact_email ?? ''),
    contactName: String(r.contact_name ?? ''),
    customerId: r.customer_id === null || r.customer_id === undefined ? null : Number(r.customer_id),
    lines: parseLines(r.basket_lines),
    subtotalIncl: toNum(r.subtotal_incl),
    recoveryToken: String(r.recovery_token ?? ''),
    remindedAt: asDate(r.reminded_at),
    recoveredAt: asDate(r.recovered_at),
    orderedAt: asDate(r.ordered_at),
    unsubscribed: Number(r.unsubscribed) === 1,
    updatedAt: asDate(r.updated_at),
  }
}

function asDate(value: unknown): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Read the stored lines back, defensively.
 *
 * The column is JSON, but a driver may hand it back as a string or an object
 * depending on version, and a row written by an older shape must not throw
 * from inside a cron sweep. Anything unreadable becomes an empty basket, which
 * the sweep then skips — see `dueForReminder`.
 */
function parseLines(value: unknown): SavedBasketLine[] {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const line = entry as { productId?: unknown; qty?: unknown }
      return { productId: Number(line?.productId), qty: Number(line?.qty) }
    })
    .filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0)
}

/** URL-safe, unguessable, and the same length every time. */
function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Save or replace this shopper's basket.
 *
 * An UPSERT on the email, which is the identity a reminder is addressed to.
 * Without that a second visit writes a second row and the sweep sends one
 * email per row — the exact failure "one reminder, ever" exists to prevent.
 *
 * ── SAVING AGAIN RE-ARMS THE REMINDER ────────────────────────────────────
 *
 * `reminded_at` is cleared on update. Someone who saved a basket last week,
 * got their reminder, and has now saved a NEW basket is a different situation
 * from someone who ignored one — and the second basket deserves its own single
 * reminder. Without this an early saver would be reminded once, ever, no
 * matter how many baskets they later left behind.
 *
 * The recovery token is NOT regenerated, so a link already sitting in an inbox
 * keeps working and lands on the current basket.
 */
export async function saveBasket(
  siteId: number,
  input: {
    contactEmail: string
    contactName?: string
    customerId?: number | null
    lines: SavedBasketLine[]
    subtotalIncl?: number
  },
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const email = input.contactEmail.trim().toLowerCase()
  // Deliberately loose. This is a "where do we write to you" box, not an
  // identity check, and refusing an unusual but valid address is worse than
  // storing one that bounces.
  if (!email || !email.includes('@') || email.length > 190) {
    return { ok: false, error: 'Please enter an email address we can send it to.' }
  }

  const lines = input.lines
    .map((l) => ({ productId: Number(l.productId), qty: Number(l.qty) }))
    .filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0)
    .slice(0, 200)

  if (lines.length === 0) return { ok: false, error: 'There is nothing in your basket yet.' }

  const token = newToken()

  await siteExecute(
    siteId,
    `INSERT INTO online_saved_baskets
       (contact_email, contact_name, customer_id, basket_lines, subtotal_incl, recovery_token)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       contact_name  = VALUES(contact_name),
       customer_id   = VALUES(customer_id),
       basket_lines  = VALUES(basket_lines),
       subtotal_incl = VALUES(subtotal_incl),
       -- A new basket earns a new reminder. See the note above.
       reminded_at   = NULL,
       recovered_at  = NULL,
       ordered_at    = NULL`,
    [
      email,
      (input.contactName ?? '').trim().slice(0, 160),
      input.customerId ?? null,
      JSON.stringify(lines),
      (input.subtotalIncl ?? 0).toFixed(4),
      token,
    ],
  )

  // Re-read rather than assume: on an update the stored token is the ORIGINAL
  // one, not the one just generated, and the caller needs the link that works.
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT recovery_token FROM online_saved_baskets WHERE contact_email = ?',
    [email],
  )
  return { ok: true, token: String(row?.recovery_token ?? token) }
}

/** A basket by its recovery token, or null. */
export async function basketByToken(
  siteId: number,
  token: string,
): Promise<SavedBasket | null> {
  if (!token || token.length > 64) return null
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM online_saved_baskets WHERE recovery_token = ?',
    [token],
  )
  return row ? mapBasket(row) : null
}

/**
 * Baskets that have gone quiet and have not been written to yet.
 *
 * Every condition is a reason NOT to email someone, which is why they are all
 * here rather than spread across the caller:
 *
 *   reminded_at IS NULL   — one reminder, ever
 *   recovered_at IS NULL  — they came back; nothing to remind them of
 *   ordered_at IS NULL    — they bought it; asking is embarrassing
 *   unsubscribed = 0      — they said stop
 *   updated_at < cutoff   — they may simply still be shopping
 */
export async function dueForReminder(
  siteId: number,
  olderThanHours: number,
  limit = 100,
): Promise<SavedBasket[]> {
  const hours = Math.min(Math.max(Math.round(olderThanHours), 1), 24 * 14)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM online_saved_baskets
      WHERE reminded_at IS NULL
        AND recovered_at IS NULL
        AND ordered_at IS NULL
        AND unsubscribed = 0
        AND updated_at < (NOW() - INTERVAL ? HOUR)
      ORDER BY updated_at
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    [hours],
  )
  // An unreadable or emptied basket is nothing to write about.
  return rows.map(mapBasket).filter((b) => b.lines.length > 0)
}

/**
 * Mark a reminder as sent.
 *
 * Called whether or not the send SUCCEEDED, and that is deliberate: a broken
 * mail server must not turn into the same shopper being retried every time the
 * cron fires. One attempt is what was promised.
 */
export async function markReminded(siteId: number, id: number): Promise<void> {
  await siteExecute(
    siteId,
    'UPDATE online_saved_baskets SET reminded_at = NOW() WHERE id = ?',
    [id],
  )
}

/** They followed the link back. */
export async function markRecovered(siteId: number, id: number): Promise<void> {
  await siteExecute(
    siteId,
    'UPDATE online_saved_baskets SET recovered_at = NOW() WHERE id = ?',
    [id],
  )
}

/**
 * They checked out — stop tracking this basket.
 *
 * Matched on email rather than id because the order knows who placed it and
 * not which saved basket it came from. A shopper who saved a basket and then
 * ordered anything at all has stopped being someone to chase.
 */
export async function markOrdered(siteId: number, contactEmail: string): Promise<void> {
  const email = contactEmail.trim().toLowerCase()
  if (!email) return
  await siteExecute(
    siteId,
    'UPDATE online_saved_baskets SET ordered_at = NOW() WHERE contact_email = ? AND ordered_at IS NULL',
    [email],
  )
}

/**
 * Stop emailing this shopper.
 *
 * Sets a flag rather than deleting the row: the basket may still be recovered
 * from a link they already hold, and a deleted row would be recreated the next
 * time they saved anything — quietly re-subscribing someone who opted out.
 */
export async function unsubscribeBasket(siteId: number, token: string): Promise<boolean> {
  if (!token || token.length > 64) return false
  const basket = await basketByToken(siteId, token)
  if (!basket) return false
  await siteExecute(
    siteId,
    'UPDATE online_saved_baskets SET unsubscribed = 1 WHERE id = ?',
    [basket.id],
  )
  return true
}

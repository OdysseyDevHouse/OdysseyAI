import 'server-only'
import { randomInt } from 'crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { VOUCHER_ALPHABET } from '../loyaltyRules'
import { logActivity, type Actor } from './activityLog'
import { today as localToday } from './ledger'

/**
 * Gift cards — sellable bearer stored value.
 *
 * ── A CARD IS A TENDER, NOT A VOUCHER ────────────────────────────────────
 *
 * A loyalty voucher is single-use and customer-attached: a status flip. A
 * gift card is a BEARER instrument with a persistent balance, partial
 * redemption and (schema-ready) reload — so its truth is a ledger
 * (gift_card_events, signed amounts) with a cached balance refreshed inside
 * every write transaction, the loyalty rule from 052. Redemption rides
 * `sales_tenders` like any payment, because the money was already paid in
 * when the card sold; the till never nets it off what is owed.
 *
 * ── WHAT THE TWO TX FUNCTIONS PROMISE ────────────────────────────────────
 *
 * `activateGiftCardForSale` and `redeemGiftCardForSale` JOIN THE SALE'S
 * TRANSACTION and THROW on refusal — the redeemVoucherForSale contract — so
 * an unaffordable redemption rolls the whole sale back, stock, number and
 * all. The real concurrency guard is the conditional UPDATE under FOR
 * UPDATE, not the SELECT: two tills can both read a balance of 100; only
 * one gets affectedRows = 1.
 *
 * Codes are 12 characters of the no-vowel no-confusable alphabet, drawn
 * from crypto.randomInt — a bearer code IS money, so it gets a CSPRNG where
 * a voucher settles for Math.random. Stored plain, deliberately: the
 * management screen lists and reprints them, and an attacker with database
 * write access could mint balances regardless, so hashing would cost every
 * read path and buy almost nothing.
 */

type Row = RowDataPacket & Record<string, unknown>

export type GiftCardStatus = 'pending' | 'active' | 'redeemed' | 'expired' | 'void'

export type GiftCard = {
  id: number
  code: string
  status: GiftCardStatus
  initialValue: number
  balance: number
  expiresOn: string | null
  activatedAt: Date | null
  activatedDocNumber: string
  customerId: number | null
  note: string
  createdAt: Date
}

export type GiftCardEvent = {
  id: number
  entryType: 'activation' | 'redeem' | 'reload' | 'refund' | 'expire' | 'adjust'
  amount: number
  documentNumber: string
  note: string
  userName: string
  createdAt: Date
}

export type Result = { ok: true } | { ok: false; error: string }

export const GIFT_CARD_CODE_LENGTH = 12

/** XXXX-XXXX-XXXX for slips and screens; storage stays unbroken uppercase. */
export function formatGiftCardCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

/** What a scanner or a person typed, back to the stored form. */
export function normaliseGiftCardCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '')
}

function makeCode(): string {
  let code = ''
  for (let i = 0; i < GIFT_CARD_CODE_LENGTH; i++) {
    code += VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)]
  }
  return code
}

function mapCard(r: Row): GiftCard {
  return {
    id: Number(r.id),
    code: String(r.code),
    status: String(r.status) as GiftCardStatus,
    initialValue: toNum(r.initial_value),
    balance: toNum(r.balance),
    expiresOn: r.expires_on === null ? null : String(r.expires_on).slice(0, 10),
    activatedAt: (r.activated_at as Date | null) ?? null,
    activatedDocNumber: String(r.activated_doc_number ?? ''),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    note: String(r.note ?? ''),
    createdAt: r.created_at as Date,
  }
}

/* ── Lookup ───────────────────────────────────────────────────────────────── */

/** Reserves nothing — the till's and storefront's preview. */
export async function findGiftCard(siteId: number, code: string): Promise<GiftCard | null> {
  const normalised = normaliseGiftCardCode(code)
  if (!normalised) return null
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM gift_cards WHERE code = ? LIMIT 1', [
    normalised,
  ])
  return row ? mapCard(row) : null
}

/**
 * The one refusal authority for "can this card pay right now".
 *
 * Used by the till action, the storefront preview and the finalise pre-check,
 * so all three phrase the same refusal the same way. Null means spendable.
 */
export function giftCardRefusal(card: GiftCard | null, code: string, today: string): string | null {
  const shown = formatGiftCardCode(normaliseGiftCardCode(code))
  if (!card) return `No gift card with the number ${shown}.`
  if (card.status === 'pending') return `Card ${shown} has not been sold yet.`
  if (card.status === 'void') return `Card ${shown} has been cancelled.`
  if (card.status === 'redeemed' || card.balance <= 0) {
    return `Card ${shown} has nothing left on it.`
  }
  if (card.status === 'expired') return `Card ${shown} has expired.`
  if (card.expiresOn && card.expiresOn < today) {
    return `Card ${shown} expired on ${card.expiresOn}.`
  }
  return null
}

/* ── Generating stock ─────────────────────────────────────────────────────── */

/**
 * Pre-generates pending cards — the box of unsold plastic behind the counter.
 *
 * Retries on a code collision rather than pre-checking: the unique index is
 * the real guard, and over 26^12 codes a clash is astronomically rare.
 */
export async function generateGiftCards(
  siteId: number,
  actor: Actor,
  input: { count: number; note?: string },
): Promise<{ ok: true; codes: string[] } | { ok: false; error: string }> {
  const count = Math.floor(input.count)
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    return { ok: false, error: 'Generate between 1 and 500 cards at a time.' }
  }

  const codes: string[] = []
  await siteTransaction(siteId, async (tx) => {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; ; attempt++) {
        const code = makeCode()
        try {
          await tx.execute(
            `INSERT INTO gift_cards (code, status, note, user_id, user_name)
             VALUES (?, 'pending', ?, ?, ?)`,
            [code, (input.note ?? '').slice(0, 255), actor.userId, actor.userName.slice(0, 120)] as never,
          )
          codes.push(code)
          break
        } catch (error) {
          if ((error as { code?: string }).code !== 'ER_DUP_ENTRY' || attempt >= 5) throw error
        }
      }
    }
  })

  await logActivity(siteId, actor, {
    entity: 'gift_card',
    entityId: null,
    action: 'gift_cards_generated',
    detail: `${count} card${count === 1 ? '' : 's'} generated`,
  })
  return { ok: true, codes }
}

/* ── The sale hooks — join the sale's transaction, throw on refusal ───────── */

export async function activateGiftCardForSale(
  tx: PoolConnection,
  actor: Actor,
  input: {
    code: string
    amount: number
    documentId: number
    documentNumber: string
    validityMonths: number
    shiftId: number | null
    terminalId: number | null
  },
): Promise<{ cardId: number }> {
  const code = normaliseGiftCardCode(input.code)
  const shown = formatGiftCardCode(code)
  const amount = round(input.amount, 4)
  if (!(amount > 0)) throw new Error(`Card ${shown} needs an amount above zero.`)
  if (code.length < 6) throw new Error('That is not a gift card number.')

  const expiresOn =
    input.validityMonths > 0
      ? (() => {
          const [y, m, d] = localToday().split('-').map(Number)
          const date = new Date(y, m - 1 + input.validityMonths, d)
          return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        })()
      : null

  const [[row]] = await tx.query<Row[]>('SELECT * FROM gift_cards WHERE code = ? FOR UPDATE', [
    code,
  ] as never)

  let cardId: number
  if (!row) {
    // A fresh code typed or printed on the spot: the card is born active.
    const [res] = await tx.execute(
      `INSERT INTO gift_cards
         (code, status, initial_value, balance, expires_on, activated_at,
          activated_doc_id, activated_doc_number, user_id, user_name)
       VALUES (?, 'active', ?, ?, ?, NOW(3), ?, ?, ?, ?)`,
      [
        code,
        amount.toFixed(4),
        amount.toFixed(4),
        expiresOn,
        input.documentId,
        input.documentNumber,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    cardId = (res as { insertId: number }).insertId
  } else {
    const status = String(row.status)
    if (status !== 'pending') {
      throw new Error(
        status === 'active'
          ? `Card ${shown} is already active, holding ${toNum(row.balance).toFixed(2)}.`
          : `Card ${shown} has already been ${status === 'void' ? 'cancelled' : 'used'} and cannot be sold.`,
      )
    }
    const [res] = await tx.execute(
      `UPDATE gift_cards
          SET status = 'active', initial_value = ?, balance = ?, expires_on = ?,
              activated_at = NOW(3), activated_doc_id = ?, activated_doc_number = ?
        WHERE id = ? AND status = 'pending'`,
      [
        amount.toFixed(4),
        amount.toFixed(4),
        expiresOn,
        input.documentId,
        input.documentNumber,
        Number(row.id),
      ] as never,
    )
    if ((res as { affectedRows: number }).affectedRows !== 1) {
      throw new Error(`Card ${shown} was sold on another till a moment ago.`)
    }
    cardId = Number(row.id)
  }

  await tx.execute(
    `INSERT INTO gift_card_events
       (card_id, entry_type, amount, document_id, document_number, shift_id, terminal_id, user_id, user_name)
     VALUES (?, 'activation', ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      amount.toFixed(4),
      input.documentId,
      input.documentNumber,
      input.shiftId,
      input.terminalId,
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
  return { cardId }
}

/**
 * Draws value off a card for a sale — or, with a NEGATIVE amount, pays a
 * credit-note refund back ONTO it (entry_type 'refund', re-activating a
 * drained card). The conditional UPDATE with `balance >= ?` is the guard
 * that makes two tills racing over one balance safe.
 */
export async function redeemGiftCardForSale(
  tx: PoolConnection,
  actor: Actor,
  input: {
    code: string
    amount: number
    documentId: number
    documentNumber: string
    shiftId: number | null
    terminalId: number | null
  },
): Promise<{ cardId: number; balanceAfter: number }> {
  const code = normaliseGiftCardCode(input.code)
  const shown = formatGiftCardCode(code)
  const amount = round(input.amount, 4)
  if (amount === 0) throw new Error(`Card ${shown}: a zero gift card payment means nothing.`)

  const [[row]] = await tx.query<Row[]>('SELECT * FROM gift_cards WHERE code = ? FOR UPDATE', [
    code,
  ] as never)
  if (!row) throw new Error(`No gift card with the number ${shown}.`)

  const status = String(row.status)
  const cardId = Number(row.id)

  if (amount > 0) {
    // Spending.
    if (status === 'pending') throw new Error(`Card ${shown} has not been sold yet.`)
    if (status === 'void') throw new Error(`Card ${shown} has been cancelled.`)
    if (status === 'expired') throw new Error(`Card ${shown} has expired.`)
    if (status === 'redeemed') throw new Error(`Card ${shown} has nothing left on it.`)

    const expires = row.expires_on ? String(row.expires_on).slice(0, 10) : null
    // Local date — a card must not die two hours early at UTC midnight.
    if (expires && expires < localToday()) {
      await tx.execute(`UPDATE gift_cards SET status = 'expired' WHERE id = ?`, [cardId] as never)
      throw new Error(`Card ${shown} expired on ${expires}.`)
    }

    const [res] = await tx.execute(
      `UPDATE gift_cards SET balance = balance - ? WHERE id = ? AND status = 'active' AND balance >= ?`,
      [amount.toFixed(4), cardId, amount.toFixed(4)] as never,
    )
    if ((res as { affectedRows: number }).affectedRows !== 1) {
      throw new Error(
        `Card ${shown} holds ${toNum(row.balance).toFixed(2)} — not enough for ${amount.toFixed(2)}.`,
      )
    }
  } else {
    // A refund landing back on the card. A cancelled card stays cancelled;
    // anything else takes the money and comes back to life if it was drained.
    if (status === 'void') throw new Error(`Card ${shown} has been cancelled.`)
    if (status === 'pending') throw new Error(`Card ${shown} has not been sold yet.`)
    await tx.execute(`UPDATE gift_cards SET balance = balance - ?, status = 'active' WHERE id = ?`, [
      amount.toFixed(4),
      cardId,
    ] as never)
  }

  await tx.execute(
    `INSERT INTO gift_card_events
       (card_id, entry_type, amount, document_id, document_number, shift_id, terminal_id, user_id, user_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      amount > 0 ? 'redeem' : 'refund',
      (-amount).toFixed(4),
      input.documentId,
      input.documentNumber,
      input.shiftId,
      input.terminalId,
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )

  const [[after]] = await tx.query<Row[]>('SELECT balance FROM gift_cards WHERE id = ?', [
    cardId,
  ] as never)
  const balanceAfter = toNum(after?.balance)
  if (amount > 0 && balanceAfter <= 0.0049) {
    await tx.execute(`UPDATE gift_cards SET status = 'redeemed' WHERE id = ?`, [cardId] as never)
  }
  return { cardId, balanceAfter }
}

/* ── Void path ────────────────────────────────────────────────────────────── */

/**
 * Unwinds a voided document's card traffic. Never throws to its caller —
 * voids must not fail on the courtesy work.
 *
 * Redemptions come back as balance; an activation is voided outright — unless
 * the card has been spent since, in which case it is left standing and logged,
 * because clawing value out of a part-spent bearer card is a conversation, not
 * a query.
 */
export async function restoreGiftCardsForDocument(
  siteId: number,
  documentId: number,
): Promise<number> {
  let touched = 0
  await siteTransaction(siteId, async (tx) => {
    const [events] = await tx.query<Row[]>(
      `SELECT e.*, c.code, c.status AS card_status, c.balance AS card_balance, c.initial_value
         FROM gift_card_events e JOIN gift_cards c ON c.id = e.card_id
        WHERE e.document_id = ? AND e.entry_type IN ('activation','redeem','refund')
        ORDER BY e.id`,
      [documentId] as never,
    )
    for (const event of events) {
      const cardId = Number(event.card_id)
      const type = String(event.entry_type)
      if (type === 'redeem') {
        // Money comes back onto the card.
        await tx.execute(
          `UPDATE gift_cards SET balance = balance + ?, status = 'active'
            WHERE id = ? AND status IN ('active','redeemed')`,
          [toNum(event.amount) === 0 ? '0.0000' : Math.abs(toNum(event.amount)).toFixed(4), cardId] as never,
        )
        touched++
      } else if (type === 'refund') {
        // A refund the void takes back off the card — only what is still there.
        const take = Math.abs(toNum(event.amount))
        await tx.execute(
          `UPDATE gift_cards SET balance = balance - ? WHERE id = ? AND balance >= ?`,
          [take.toFixed(4), cardId, take.toFixed(4)] as never,
        )
        touched++
      } else {
        // Activation: void the card only while it is still whole.
        const [res] = await tx.execute(
          `UPDATE gift_cards SET status = 'void', balance = 0
            WHERE id = ? AND status = 'active' AND ABS(balance - initial_value) < 0.005`,
          [cardId] as never,
        )
        if ((res as { affectedRows: number }).affectedRows === 1) touched++
        // else: part-spent — left standing, surfaced by the caller's log.
      }
    }
  })
  return touched
}

/* ── Management ───────────────────────────────────────────────────────────── */

export async function adjustGiftCard(
  siteId: number,
  actor: Actor,
  id: number,
  amount: number,
  note: string,
): Promise<Result> {
  const value = round(amount, 4)
  if (!Number.isFinite(value) || value === 0) return { ok: false, error: 'Enter an amount.' }
  if (!note.trim()) return { ok: false, error: 'Say why the balance is being adjusted.' }

  try {
    await siteTransaction(siteId, async (tx) => {
      const [[row]] = await tx.query<Row[]>('SELECT * FROM gift_cards WHERE id = ? FOR UPDATE', [
        id,
      ] as never)
      if (!row) throw new Error('That card no longer exists.')
      const status = String(row.status)
      if (status === 'void') throw new Error('A cancelled card cannot be adjusted.')
      if (status === 'pending') throw new Error('The card has not been sold yet.')
      if (value < 0 && toNum(row.balance) + value < -0.0049) {
        throw new Error(`The card holds ${toNum(row.balance).toFixed(2)} — it cannot go negative.`)
      }
      await tx.execute(
        `UPDATE gift_cards
            SET balance = balance + ?,
                status = CASE WHEN balance + ? > 0.0049 THEN 'active' ELSE 'redeemed' END
          WHERE id = ?`,
        [value.toFixed(4), value.toFixed(4), id] as never,
      )
      await tx.execute(
        `INSERT INTO gift_card_events (card_id, entry_type, amount, note, user_id, user_name)
         VALUES (?, 'adjust', ?, ?, ?, ?)`,
        [id, value.toFixed(4), note.trim().slice(0, 255), actor.userId, actor.userName.slice(0, 120)] as never,
      )
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not adjust the card.' }
  }

  // The GL follows the subledger, fail-soft as ever: an adjustment moves the
  // liability with no sale behind it, so it posts against the breakage/goodwill
  // account — the miscellaneous bucket for value granted or removed by hand.
  try {
    const { mirrorGiftCardAdjustment } = await import('./glPosting')
    await mirrorGiftCardAdjustment(siteId, actor, {
      cardId: id,
      amount: value,
      note: note.trim(),
      date: localToday(),
    })
  } catch (error) {
    console.error('[gift-cards] adjustment mirror failed for card', id, error)
  }

  await logActivity(siteId, actor, {
    entity: 'gift_card',
    entityId: null,
    action: 'gift_card_adjusted',
    detail: `Card #${id} adjusted by ${value.toFixed(2)} — ${note.trim()}`,
  })
  return { ok: true }
}

export async function voidGiftCard(siteId: number, actor: Actor, id: number): Promise<Result> {
  const res = await siteExecute(
    siteId,
    `UPDATE gift_cards SET status = 'void', balance = 0 WHERE id = ? AND status IN ('pending','active')`,
    [id],
  )
  if (res.affectedRows !== 1) {
    return { ok: false, error: 'Only a pending or active card can be cancelled.' }
  }
  await logActivity(siteId, actor, {
    entity: 'gift_card',
    entityId: null,
    action: 'gift_card_voided',
    detail: `Card #${id} cancelled`,
  })
  return { ok: true }
}

/* ── Expiry sweep ─────────────────────────────────────────────────────────── */

/**
 * Expires lapsed cards and returns what fell off, for the breakage journal.
 *
 * Button-driven (the recurring-journals precedent). One 'expire' event per
 * card zeroes its balance; the caller posts ONE breakage mirror for the run's
 * total AFTER this commits, so a mirror failure never un-expires a card.
 * Repeat-safe: a second run finds nothing active past its date.
 */
export async function expireGiftCards(
  siteId: number,
  actor: Actor,
): Promise<{ cards: number; value: number }> {
  const today = localToday()
  let cards = 0
  let value = 0

  await siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, balance FROM gift_cards
        WHERE status = 'active' AND expires_on IS NOT NULL AND expires_on < ? FOR UPDATE`,
      [today] as never,
    )
    for (const row of rows) {
      const balance = toNum(row.balance)
      if (balance > 0) {
        await tx.execute(
          `INSERT INTO gift_card_events (card_id, entry_type, amount, note, user_id, user_name)
           VALUES (?, 'expire', ?, ?, ?, ?)`,
          [
            Number(row.id),
            (-balance).toFixed(4),
            `Expiry sweep ${today}`,
            actor.userId,
            actor.userName.slice(0, 120),
          ] as never,
        )
        value += balance
      }
      await tx.execute(`UPDATE gift_cards SET status = 'expired', balance = 0 WHERE id = ?`, [
        Number(row.id),
      ] as never)
      cards++
    }
  })

  if (cards > 0) {
    await logActivity(siteId, actor, {
      entity: 'gift_card',
      entityId: null,
      action: 'gift_cards_expired',
      detail: `${cards} card${cards === 1 ? '' : 's'} expired, ${value.toFixed(2)} to breakage`,
    })
  }
  return { cards, value: round(value, 2) }
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export async function listGiftCards(
  siteId: number,
  opts: { status?: GiftCardStatus; search?: string; limit?: number } = {},
): Promise<GiftCard[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    where.push('status = ?')
    params.push(opts.status)
  }
  if (opts.search?.trim()) {
    where.push('(code LIKE ? OR activated_doc_number LIKE ? OR note LIKE ?)')
    const term = `%${normaliseGiftCardCode(opts.search)}%`
    params.push(term, `%${opts.search.trim()}%`, `%${opts.search.trim()}%`)
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 200)), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM gift_cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ${limit}`,
    params,
  )
  return rows.map(mapCard)
}

export async function giftCardEvents(siteId: number, cardId: number): Promise<GiftCardEvent[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM gift_card_events WHERE card_id = ? ORDER BY id`,
    [cardId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    entryType: String(r.entry_type) as GiftCardEvent['entryType'],
    amount: toNum(r.amount),
    documentNumber: String(r.document_number ?? ''),
    note: String(r.note ?? ''),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }))
}

/** The subledger figure reconciliation compares to account 2500. */
export async function giftCardLiability(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COALESCE(SUM(balance), 0) AS held FROM gift_cards WHERE status = 'active'`,
  )
  return toNum(row?.held)
}

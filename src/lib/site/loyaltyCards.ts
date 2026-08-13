import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import {
  cardCompletions,
  stampsForBasket,
  VOUCHER_ALPHABET,
  VOUCHER_CODE_LENGTH,
  type LoyaltyCard,
  type LoyaltySettings,
  type LoyaltyTier,
  type StampLine,
} from '../loyaltyRules'
import { logActivity, type Actor } from './activityLog'
import { today as localToday } from './ledger'
import { getLoyaltySettings, listTiers, insertLedger, refreshMember } from './loyalty'

/**
 * Punch cards, stamps and vouchers.
 *
 * "Buy ten coffees, get the eleventh free." Three tables and one rule that
 * makes the whole thing safe to retry:
 *
 *   STAMPS ARE APPEND-ONLY. Progress on a card is COUNT(rows) since the
 *   customer last completed it, never a counter that is incremented. A refund
 *   deletes that sale's stamps and the progress is simply right again, with no
 *   arithmetic to get wrong and nothing for two tills to race over.
 *
 *   A VOUCHER IS A STATE MACHINE. issued → redeemed | expired | void, and
 *   redemption is a CONDITIONAL update inside the sale's transaction. That —
 *   not a read-then-write — is what stops a photographed code being spent at
 *   two tills at once.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Cards ───────────────────────────────────────────────────────────────── */

function mapCard(r: Row): Omit<LoyaltyCard, 'productIds' | 'departmentIds'> {
  return {
    id: Number(r.id),
    name: String(r.name),
    isActive: !!r.is_active,
    requiredStamps: Number(r.required_stamps),
    rewardType: String(r.reward_type) as LoyaltyCard['rewardType'],
    rewardProductId: r.reward_product_id === null ? null : Number(r.reward_product_id),
    rewardProductName: (r.reward_product_name as string | null) ?? null,
    rewardValue: toNum(r.reward_value),
    oneStampPerSale: !!r.one_stamp_per_sale,
    minLineAmount: toNum(r.min_line_amount),
    voucherValidDays: Number(r.voucher_valid_days),
    startsOn: (r.starts_on as string | null) ?? null,
    endsOn: (r.ends_on as string | null) ?? null,
  }
}

const SELECT_CARD = `
  SELECT c.id, c.name, c.is_active, c.required_stamps, c.reward_type, c.reward_product_id,
         c.reward_value, c.one_stamp_per_sale, c.min_line_amount, c.voucher_valid_days,
         c.starts_on, c.ends_on, p.description AS reward_product_name
    FROM loyalty_cards c
    LEFT JOIN products p ON p.id = c.reward_product_id
`

/** Cards with their scope rows attached. */
export async function listCards(siteId: number, activeOnly = false): Promise<LoyaltyCard[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CARD} ${activeOnly ? 'WHERE c.is_active = 1' : ''} ORDER BY c.name ASC`,
  )
  if (rows.length === 0) return []

  const ids = rows.map((r) => Number(r.id))
  const items = await siteQuery<Row>(
    siteId,
    `SELECT card_id, product_id, department_id
       FROM loyalty_card_items WHERE card_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )

  const products = new Map<number, number[]>()
  const departments = new Map<number, number[]>()
  for (const item of items) {
    const cardId = Number(item.card_id)
    if (item.product_id !== null) {
      products.set(cardId, [...(products.get(cardId) ?? []), Number(item.product_id)])
    }
    if (item.department_id !== null) {
      departments.set(cardId, [...(departments.get(cardId) ?? []), Number(item.department_id)])
    }
  }

  return rows.map((r) => ({
    ...mapCard(r),
    productIds: products.get(Number(r.id)) ?? [],
    departmentIds: departments.get(Number(r.id)) ?? [],
  }))
}

export type CardInput = {
  name: string
  isActive: boolean
  requiredStamps: number
  rewardType: LoyaltyCard['rewardType']
  rewardProductId: number | null
  rewardValue: number
  oneStampPerSale: boolean
  minLineAmount: number
  voucherValidDays: number
  startsOn: string | null
  endsOn: string | null
  productIds: number[]
  departmentIds: number[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type Result = { ok: true } | { ok: false; error: string }

export function validateCard(input: CardInput): string | null {
  if (!input.name?.trim()) return 'Give the card a name.'
  if (input.name.trim().length > 100) return 'That name is too long — 100 characters at most.'
  if (!Number.isFinite(input.requiredStamps) || input.requiredStamps < 1) {
    return 'A card needs at least one stamp to complete.'
  }
  if (input.requiredStamps > 100) return 'A hundred stamps is the most a card can ask for.'

  if (input.rewardType === 'free_item' && !input.rewardProductId) {
    return 'Choose the product the customer gets free.'
  }
  if (input.rewardType !== 'free_item' && input.rewardValue <= 0) {
    return input.rewardType === 'points'
      ? 'Enter how many bonus points completing the card gives.'
      : 'Enter what the voucher is worth.'
  }
  if (input.minLineAmount < 0) return 'The minimum item value cannot be negative.'
  if (input.voucherValidDays < 0) return 'Voucher validity cannot be negative.'

  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    return 'The card cannot end before it starts.'
  }
  return null
}

async function writeItems(tx: PoolConnection, cardId: number, input: CardInput): Promise<void> {
  await tx.execute('DELETE FROM loyalty_card_items WHERE card_id = ?', [cardId] as never)

  // De-duplicated before insert: the unique keys would refuse a repeat anyway,
  // and a picker that let someone add the same product twice should not surface
  // a constraint error.
  for (const productId of [...new Set(input.productIds)]) {
    await tx.execute(
      'INSERT INTO loyalty_card_items (card_id, product_id) VALUES (?,?)',
      [cardId, productId] as never,
    )
  }
  for (const departmentId of [...new Set(input.departmentIds)]) {
    await tx.execute(
      'INSERT INTO loyalty_card_items (card_id, department_id) VALUES (?,?)',
      [cardId, departmentId] as never,
    )
  }
}

function cardColumns(input: CardInput): unknown[] {
  return [
    input.name.trim(),
    input.isActive ? 1 : 0,
    Math.floor(input.requiredStamps),
    input.rewardType,
    input.rewardType === 'free_item' ? input.rewardProductId : null,
    round(input.rewardType === 'free_item' ? 0 : input.rewardValue, 4).toFixed(4),
    input.oneStampPerSale ? 1 : 0,
    round(input.minLineAmount, 4).toFixed(4),
    Math.floor(input.voucherValidDays),
    input.startsOn || null,
    input.endsOn || null,
  ]
}

export async function createCard(
  siteId: number,
  actor: Actor,
  input: CardInput,
): Promise<SaveResult> {
  const invalid = validateCard(input)
  if (invalid) return { ok: false, error: invalid }

  const id = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO loyalty_cards
         (name, is_active, required_stamps, reward_type, reward_product_id, reward_value,
          one_stamp_per_sale, min_line_amount, voucher_valid_days, starts_on, ends_on)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      cardColumns(input) as never,
    )
    const cardId = (res as { insertId: number }).insertId
    await writeItems(tx, cardId, input)
    return cardId
  })

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: 'card_created',
    detail: `${input.name.trim()} · ${input.requiredStamps} stamps`,
  })

  return { ok: true, id }
}

export async function updateCard(
  siteId: number,
  actor: Actor,
  id: number,
  input: CardInput,
): Promise<SaveResult> {
  const invalid = validateCard(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await siteQueryOne<Row>(siteId, 'SELECT id FROM loyalty_cards WHERE id = ?', [id])
  if (!existing) return { ok: false, error: 'That card no longer exists.' }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE loyalty_cards SET
         name = ?, is_active = ?, required_stamps = ?, reward_type = ?, reward_product_id = ?,
         reward_value = ?, one_stamp_per_sale = ?, min_line_amount = ?, voucher_valid_days = ?,
         starts_on = ?, ends_on = ?
       WHERE id = ?`,
      [...cardColumns(input), id] as never,
    )
    await writeItems(tx, id, input)
  })

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: 'card_changed',
    detail: input.name.trim(),
  })

  return { ok: true, id }
}

export async function setCardActive(
  siteId: number,
  actor: Actor,
  id: number,
  isActive: boolean,
): Promise<Result> {
  await siteExecute(siteId, 'UPDATE loyalty_cards SET is_active = ? WHERE id = ?', [
    isActive ? 1 : 0,
    id,
  ])
  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: isActive ? 'card_started' : 'card_stopped',
    detail: `Card ${id}`,
  })
  return { ok: true }
}

/**
 * Deletes a card.
 *
 * Refused once it has stamps on it. Those stamps are a customer's progress
 * towards a reward they were promised, and the FK would cascade them away
 * silently — someone three coffees from a free one would simply lose them.
 * Stopping the card is the reversible alternative and is what the error says.
 */
export async function deleteCard(siteId: number, actor: Actor, id: number): Promise<Result> {
  const used = await siteQueryOne<Row>(
    siteId,
    'SELECT COUNT(*) AS n FROM loyalty_stamps WHERE card_id = ?',
    [id],
  )
  const stamps = Number(used?.n ?? 0)
  if (stamps > 0) {
    return {
      ok: false,
      error: `This card has ${stamps} stamp${stamps === 1 ? '' : 's'} on it. Stop it instead — deleting it would wipe progress customers have already earned.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM loyalty_cards WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: 'card_deleted',
    detail: `Card ${id}`,
  })
  return { ok: true }
}

/* ── Progress ────────────────────────────────────────────────────────────── */

export type CardProgress = {
  cardId: number
  name: string
  requiredStamps: number
  stamps: number
  rewardType: LoyaltyCard['rewardType']
  rewardLabel: string
}

function rewardLabel(card: LoyaltyCard): string {
  if (card.rewardType === 'free_item') return card.rewardProductName ?? 'A free product'
  if (card.rewardType === 'points') return `${card.rewardValue} bonus points`
  return `R${card.rewardValue.toFixed(2)} voucher`
}

/**
 * How far along each running card this customer is.
 *
 * Progress is stamps SINCE the last completion, which is what the modulo of the
 * total gives — so a customer on their third free coffee shows 2/10, not 22/10.
 */
export async function getCardProgress(
  siteId: number,
  customerId: number,
): Promise<CardProgress[]> {
  const cards = await listCards(siteId, true)
  if (cards.length === 0) return []

  const counts = await siteQuery<Row>(
    siteId,
    `SELECT card_id, COUNT(*) AS n FROM loyalty_stamps
      WHERE customer_id = ? GROUP BY card_id`,
    [customerId],
  )
  const byCard = new Map(counts.map((r) => [Number(r.card_id), Number(r.n)]))

  return cards.map((card) => {
    const total = byCard.get(card.id) ?? 0
    const { progress } = cardCompletions(total, card.requiredStamps)
    return {
      cardId: card.id,
      name: card.name,
      requiredStamps: card.requiredStamps,
      stamps: progress,
      rewardType: card.rewardType,
      rewardLabel: rewardLabel(card),
    }
  })
}

/* ── Stamping a sale ─────────────────────────────────────────────────────── */

export type StampResult = { stamps: number; vouchers: string[]; bonusPoints: number }

/**
 * Awards stamps for a sale and issues whatever they complete.
 *
 * Runs AFTER the sale commits, like earning, and for the same reason: a punch
 * card must not be able to stop a shop trading. Fail-soft by contract.
 *
 * IDEMPOTENT per (card, customer, document, sequence) via uq_stamp_sale. A
 * retried finalise re-attempts the same inserts and the database refuses the
 * duplicates, so nobody gets two stamps for one coffee.
 */
export async function awardSaleStamps(
  siteId: number,
  actor: Actor,
  input: {
    customerId: number
    documentId: number
    documentNumber: string
    lines: readonly StampLine[]
  },
): Promise<StampResult> {
  const settings = await getLoyaltySettings(siteId)
  const empty: StampResult = { stamps: 0, vouchers: [], bonusPoints: 0 }
  if (!settings.enabled) return empty

  const cards = await listCards(siteId, true)
  if (cards.length === 0) return empty

  const now = new Date()
  const tiers = await listTiers(siteId)

  let awarded = 0
  let bonusPoints = 0
  const vouchers: string[] = []

  for (const card of cards) {
    const due = stampsForBasket(input.lines, card, now)
    if (due <= 0) continue

    try {
      const result = await siteTransaction(siteId, async (tx) => {
        // Already stamped for this sale? A retry, so nothing to do.
        const [[existing]] = await tx.query<Row[]>(
          'SELECT COUNT(*) AS n FROM loyalty_stamps WHERE card_id = ? AND document_id = ? AND customer_id = ?',
          [card.id, input.documentId, input.customerId] as never,
        )
        if (Number(existing?.n ?? 0) > 0) return { stamps: 0, codes: [] as string[], points: 0 }

        const [[before]] = await tx.query<Row[]>(
          'SELECT COUNT(*) AS n FROM loyalty_stamps WHERE card_id = ? AND customer_id = ? FOR UPDATE',
          [card.id, input.customerId] as never,
        )
        const priorTotal = Number(before?.n ?? 0)
        const priorCompleted = cardCompletions(priorTotal, card.requiredStamps).completed

        const stampIds: number[] = []
        for (let seq = 1; seq <= due; seq++) {
          const [res] = await tx.execute(
            `INSERT INTO loyalty_stamps
               (card_id, customer_id, document_id, stamp_seq, product_id)
             VALUES (?,?,?,?,?)`,
            [card.id, input.customerId, input.documentId, seq, null] as never,
          )
          stampIds.push((res as { insertId: number }).insertId)
        }

        const nowCompleted = cardCompletions(priorTotal + due, card.requiredStamps).completed
        const earnedNow = nowCompleted - priorCompleted

        const codes: string[] = []
        let points = 0

        for (let i = 0; i < earnedNow; i++) {
          if (card.rewardType === 'points') {
            // A points reward needs no voucher — it lands straight on the
            // balance, where the customer can see it immediately.
            await insertLedger(tx, actor, {
              customerId: input.customerId,
              entryType: 'adjust',
              points: card.rewardValue,
              documentId: input.documentId,
              documentNumber: input.documentNumber,
              note: `${card.name} completed`,
            })
            points = round(points + card.rewardValue, 4)
          } else {
            const voucher = await issueVoucherTx(tx, actor, {
              customerId: input.customerId,
              rewardType: card.rewardType === 'free_item' ? 'free_item' : 'value',
              rewardProductId: card.rewardProductId,
              rewardValue: card.rewardValue,
              description: card.name,
              validDays: card.voucherValidDays,
              issuedBy: 'card',
              cardId: card.id,
            })
            codes.push(voucher.code)

            // Mark the stamp that completed the run, so the history shows which
            // one earned the reward rather than leaving it to be inferred.
            const completingId = stampIds[Math.min(stampIds.length - 1, i)]
            if (completingId !== undefined) {
              await tx.execute(
                'UPDATE loyalty_stamps SET completed = 1, voucher_id = ? WHERE id = ?',
                [voucher.id, completingId] as never,
              )
            }
          }
        }

        if (points > 0) {
          await refreshMember(tx, input.customerId, settings, tiers)
        }

        return { stamps: due, codes, points }
      })

      awarded += result.stamps
      vouchers.push(...result.codes)
      bonusPoints = round(bonusPoints + result.points, 4)
    } catch (error) {
      // A duplicate means a concurrent finalise already stamped this sale.
      const code = (error as { code?: string }).code
      if (code !== 'ER_DUP_ENTRY') throw error
    }
  }

  return { stamps: awarded, vouchers, bonusPoints }
}

/** Removes a refunded sale's stamps, and voids anything they issued. */
export async function reverseSaleStamps(siteId: number, documentId: number): Promise<number> {
  return siteTransaction(siteId, async (tx) => {
    const [issued] = await tx.query<Row[]>(
      'SELECT voucher_id FROM loyalty_stamps WHERE document_id = ? AND voucher_id IS NOT NULL',
      [documentId] as never,
    )

    for (const row of issued) {
      // Only an UNSPENT voucher is voided. One the customer has already used is
      // left alone: the goods are gone, and voiding it would misrepresent a
      // redemption that really happened.
      await tx.execute(
        `UPDATE loyalty_vouchers SET status = 'void' WHERE id = ? AND status = 'issued'`,
        [Number(row.voucher_id)] as never,
      )
    }

    const [res] = await tx.execute('DELETE FROM loyalty_stamps WHERE document_id = ?', [
      documentId,
    ] as never)
    return (res as { affectedRows: number }).affectedRows
  })
}

/* ── Vouchers ────────────────────────────────────────────────────────────── */

export type VoucherStatus = 'issued' | 'redeemed' | 'expired' | 'void'

export type LoyaltyVoucher = {
  id: number
  code: string
  customerId: number | null
  customerName: string
  rewardType: 'free_item' | 'value'
  rewardProductId: number | null
  rewardProductName: string | null
  rewardValue: number
  description: string
  status: VoucherStatus
  issuedBy: string
  expiresOn: string | null
  redeemedAt: Date | null
  redeemedDocNumber: string
  createdAt: Date
}

function mapVoucher(r: Row): LoyaltyVoucher {
  return {
    id: Number(r.id),
    code: String(r.code),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerName: String(r.customer_name ?? ''),
    rewardType: String(r.reward_type) as 'free_item' | 'value',
    rewardProductId: r.reward_product_id === null ? null : Number(r.reward_product_id),
    rewardProductName: (r.reward_product_name as string | null) ?? null,
    rewardValue: toNum(r.reward_value),
    description: String(r.description ?? ''),
    status: String(r.status) as VoucherStatus,
    issuedBy: String(r.issued_by ?? ''),
    expiresOn: (r.expires_on as string | null) ?? null,
    redeemedAt: (r.redeemed_at as Date) ?? null,
    redeemedDocNumber: String(r.redeemed_doc_number ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_VOUCHER = `
  SELECT v.id, v.code, v.customer_id, v.reward_type, v.reward_product_id, v.reward_value,
         v.description, v.status, v.issued_by, v.expires_on, v.redeemed_at,
         v.redeemed_doc_number, v.created_at,
         c.name AS customer_name, p.description AS reward_product_name
    FROM loyalty_vouchers v
    LEFT JOIN customers c ON c.id = v.customer_id
    LEFT JOIN products p ON p.id = v.reward_product_id
`

function makeCode(): string {
  let code = ''
  for (let i = 0; i < VOUCHER_CODE_LENGTH; i++) {
    code += VOUCHER_ALPHABET[Math.floor(Math.random() * VOUCHER_ALPHABET.length)]
  }
  return code
}

export type VoucherIssueInput = {
  customerId: number | null
  rewardType: 'free_item' | 'value'
  rewardProductId?: number | null
  rewardValue?: number
  description: string
  validDays?: number
  issuedBy?: 'card' | 'manual' | 'birthday' | 'tier'
  cardId?: number | null
}

/**
 * Writes a voucher on an existing transaction.
 *
 * Retries on a code collision rather than pre-checking. With a 26-character
 * alphabet over 8 places a clash is vanishingly rare, and a SELECT-then-INSERT
 * would still race — the unique index is the real guard, so this simply asks
 * again when it fires.
 */
async function issueVoucherTx(
  tx: PoolConnection,
  actor: Actor,
  input: VoucherIssueInput,
): Promise<{ id: number; code: string }> {
  const expiresOn =
    input.validDays && input.validDays > 0
      ? new Date(Date.now() + input.validDays * 86_400_000).toISOString().slice(0, 10)
      : null

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeCode()
    try {
      const [res] = await tx.execute(
        `INSERT INTO loyalty_vouchers
           (code, customer_id, reward_type, reward_product_id, reward_value, description,
            status, issued_by, card_id, expires_on, user_id, user_name)
         VALUES (?,?,?,?,?,?, 'issued', ?,?,?,?,?)`,
        [
          code,
          input.customerId,
          input.rewardType,
          input.rewardType === 'free_item' ? (input.rewardProductId ?? null) : null,
          round(input.rewardType === 'value' ? (input.rewardValue ?? 0) : 0, 4).toFixed(4),
          input.description.slice(0, 150),
          input.issuedBy ?? 'manual',
          input.cardId ?? null,
          expiresOn,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      return { id: (res as { insertId: number }).insertId, code }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error
    }
  }
  throw new Error('Could not generate a unique voucher code.')
}

export async function issueVoucher(
  siteId: number,
  actor: Actor,
  input: VoucherIssueInput,
): Promise<{ ok: true; id: number; code: string } | { ok: false; error: string }> {
  if (!input.description.trim()) return { ok: false, error: 'Say what the voucher is for.' }
  if (input.rewardType === 'value' && (input.rewardValue ?? 0) <= 0) {
    return { ok: false, error: 'Enter what the voucher is worth.' }
  }
  if (input.rewardType === 'free_item' && !input.rewardProductId) {
    return { ok: false, error: 'Choose the free product.' }
  }

  try {
    const voucher = await siteTransaction(siteId, (tx) => issueVoucherTx(tx, actor, input))

    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: input.customerId,
      action: 'voucher_issued',
      detail: `${voucher.code} · ${input.description.trim()}`,
    })

    return { ok: true, ...voucher }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not issue the voucher.',
    }
  }
}

export async function listVouchers(
  siteId: number,
  options: { customerId?: number; spendableOnly?: boolean; limit?: number } = {},
): Promise<LoyaltyVoucher[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.customerId) {
    where.push('v.customer_id = ?')
    params.push(options.customerId)
  }
  if (options.spendableOnly) {
    where.push(`v.status = 'issued' AND (v.expires_on IS NULL OR v.expires_on >= CURDATE())`)
  }

  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 200)), 1000)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_VOUCHER} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY v.id DESC LIMIT ${limit}`,
    params,
  )
  return rows.map(mapVoucher)
}

/** Looks a code up for the till. Reserves nothing — this is a preview. */
export async function findVoucher(siteId: number, code: string): Promise<LoyaltyVoucher | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_VOUCHER} WHERE v.code = ? LIMIT 1`,
    [code.trim().toUpperCase()],
  )
  return row ? mapVoucher(row) : null
}

/**
 * Spends a voucher against a sale. JOINS THE SALE'S TRANSACTION.
 *
 * The UPDATE is conditional on the row still being `issued`, and it is that
 * condition — not the SELECT above it — that makes a copied code single-use.
 * Two tills running this concurrently both read 'issued'; only one gets
 * affectedRows = 1, and the other throws.
 */
export async function redeemVoucherForSale(
  tx: PoolConnection,
  input: { code: string; documentId: number; documentNumber: string },
): Promise<LoyaltyVoucher> {
  const code = input.code.trim().toUpperCase()

  const [[row]] = await tx.query<Row[]>(
    `SELECT id, code, customer_id, reward_type, reward_product_id, reward_value, description,
            status, issued_by, expires_on, redeemed_at, redeemed_doc_number, created_at
       FROM loyalty_vouchers WHERE code = ? FOR UPDATE`,
    [code] as never,
  )
  if (!row) throw new Error(`No voucher with code ${code}.`)

  const status = String(row.status)
  if (status === 'redeemed') throw new Error(`Voucher ${code} has already been used.`)
  if (status === 'void') throw new Error(`Voucher ${code} has been cancelled.`)
  if (status === 'expired') throw new Error(`Voucher ${code} has expired.`)

  const expires = row.expires_on ? String(row.expires_on) : null
  // Local date — a voucher must not die two hours early at UTC midnight.
  if (expires && expires < localToday()) {
    await tx.execute(`UPDATE loyalty_vouchers SET status = 'expired' WHERE id = ?`, [
      Number(row.id),
    ] as never)
    throw new Error(`Voucher ${code} expired on ${expires}.`)
  }

  const [res] = await tx.execute(
    `UPDATE loyalty_vouchers
        SET status = 'redeemed', redeemed_at = NOW(3), redeemed_doc_id = ?, redeemed_doc_number = ?
      WHERE id = ? AND status = 'issued'`,
    [input.documentId, input.documentNumber, Number(row.id)] as never,
  )
  if ((res as { affectedRows: number }).affectedRows !== 1) {
    throw new Error(`Voucher ${code} was used on another till a moment ago.`)
  }

  return mapVoucher({ ...row, status: 'redeemed' } as Row)
}

/** Cancels an unspent voucher. */
export async function voidVoucher(siteId: number, actor: Actor, id: number): Promise<Result> {
  const res = await siteExecute(
    siteId,
    `UPDATE loyalty_vouchers SET status = 'void' WHERE id = ? AND status = 'issued'`,
    [id],
  )
  if (res.affectedRows !== 1) {
    return { ok: false, error: 'Only a voucher that has not been used can be cancelled.' }
  }

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: null,
    action: 'voucher_cancelled',
    detail: `Voucher ${id}`,
  })
  return { ok: true }
}

/** Marks lapsed vouchers expired. Safe to run repeatedly. */
export async function expireVouchers(siteId: number): Promise<number> {
  const res = await siteExecute(
    siteId,
    `UPDATE loyalty_vouchers
        SET status = 'expired'
      WHERE status = 'issued' AND expires_on IS NOT NULL AND expires_on < CURDATE()`,
  )
  return res.affectedRows
}

/** Puts a voucher back when the sale that spent it is reversed. */
export async function restoreVoucherForDocument(siteId: number, documentId: number): Promise<number> {
  const res = await siteExecute(
    siteId,
    `UPDATE loyalty_vouchers
        SET status = 'issued', redeemed_at = NULL, redeemed_doc_id = NULL, redeemed_doc_number = ''
      WHERE redeemed_doc_id = ? AND status = 'redeemed'`,
    [documentId],
  )
  return res.affectedRows
}

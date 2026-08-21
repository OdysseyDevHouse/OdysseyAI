import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { loyaltyBranchDbPrefix, loyaltyExecute, loyaltyQuery, loyaltyQueryOne, loyaltyTransaction } from './loyaltyDb'
import { round, toNum } from '../decimals'
import {
  cardCompletions,
  pointsToRand,
  randToPoints,
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
import {
  getLoyaltySettings,
  listTiers,
  insertLedger,
  refreshMember,
  redeemableFor,
} from './loyalty'
import { getWalletBalance } from './loyaltyWallet'

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

function mapCard(
  r: Row,
): Omit<LoyaltyCard, 'productIds' | 'departmentIds' | 'productCodes' | 'departmentNames'> {
  return {
    id: Number(r.id),
    name: String(r.name),
    isActive: !!r.is_active,
    requiredStamps: Number(r.required_stamps),
    rewardType: String(r.reward_type) as LoyaltyCard['rewardType'],
    rewardProductCode: (r.reward_product_code as string | null) ?? null,
    rewardProductName: (r.reward_product_name as string | null) ?? null,
    rewardValue: toNum(r.reward_value),
    oneStampPerSale: !!r.one_stamp_per_sale,
    minLineAmount: toNum(r.min_line_amount),
    voucherValidDays: Number(r.voucher_valid_days),
    startsOn: (r.starts_on as string | null) ?? null,
    endsOn: (r.ends_on as string | null) ?? null,
  }
}

/**
 * A card, with the reward product's name resolved against THIS store.
 *
 * The name is a label, so a branch that does not carry the code simply shows
 * nothing rather than failing — the reward is still defined, it is just not
 * something this shop stocks.
 */
const selectCard = (bdb: string) => `
  SELECT c.id, c.name, c.is_active, c.required_stamps, c.reward_type, c.reward_product_code,
         c.reward_value, c.one_stamp_per_sale, c.min_line_amount, c.voucher_valid_days,
         c.starts_on, c.ends_on, p.description AS reward_product_name
    FROM loyalty_cards c
    LEFT JOIN ${bdb}products p ON p.code = c.reward_product_code AND p.is_archived = 0
`

/**
 * Cards with their scope attached, twice over.
 *
 * ── WHY BOTH CODES AND IDS ───────────────────────────────────────────────
 *
 * A card belongs to the GROUP, so it is defined in product codes and
 * department names — the only identifiers that mean the same thing at every
 * branch. But matching a basket line is an id comparison on the till's hot
 * path, and re-resolving a code per line would be absurd.
 *
 * So the codes are resolved ONCE here, against the caller's own product and
 * department tables, and both forms travel on the card: the definition and this
 * store's reading of it.
 *
 * A code this branch does not stock resolves to nothing and the card earns no
 * stamps here. That is the honest answer rather than a gap to paper over — a
 * shop that does not sell the item cannot award a stamp for buying it.
 */
export async function listCards(siteId: number, activeOnly = false): Promise<LoyaltyCard[]> {
  const bdb = await loyaltyBranchDbPrefix(siteId)
  const rows = await loyaltyQuery<Row>(
    siteId,
    `${selectCard(bdb)} ${activeOnly ? 'WHERE c.is_active = 1' : ''} ORDER BY c.name ASC`,
  )
  if (rows.length === 0) return []

  const ids = rows.map((r) => Number(r.id))
  const items = await loyaltyQuery<Row>(
    siteId,
    `SELECT card_id, product_code, department_name
       FROM loyalty_card_items WHERE card_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )

  const codes = new Map<number, string[]>()
  const names = new Map<number, string[]>()
  for (const item of items) {
    const cardId = Number(item.card_id)
    if (item.product_code !== null) {
      codes.set(cardId, [...(codes.get(cardId) ?? []), String(item.product_code)])
    }
    if (item.department_name !== null) {
      names.set(cardId, [...(names.get(cardId) ?? []), String(item.department_name)])
    }
  }

  const local = await resolveScope(
    siteId,
    [...new Set([...codes.values()].flat())],
    [...new Set([...names.values()].flat())],
  )

  return rows.map((r) => {
    const cardId = Number(r.id)
    const cardCodes = codes.get(cardId) ?? []
    const cardNames = names.get(cardId) ?? []
    return {
      ...mapCard(r),
      productCodes: cardCodes,
      departmentNames: cardNames,
      productIds: cardCodes.map((c) => local.products.get(c)).filter((id): id is number => !!id),
      departmentIds: cardNames.map((n) => local.departments.get(n)).filter((id): id is number => !!id),
    }
  })
}

/**
 * Turns the group's product codes and department names into this store's ids.
 *
 * One query each rather than one per card: a shop with a dozen cards scoped to
 * overlapping products would otherwise run a dozen lookups for the same code.
 *
 * Reads the CALLER's own tables, never the owner's — the whole point is what
 * this branch calls these things.
 */
async function resolveScope(
  siteId: number,
  productCodes: string[],
  departmentNames: string[],
): Promise<{ products: Map<string, number>; departments: Map<string, number> }> {
  const products = new Map<string, number>()
  const departments = new Map<string, number>()

  if (productCodes.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, code FROM products
        WHERE code IN (${productCodes.map(() => '?').join(',')}) AND is_archived = 0`,
      productCodes,
    )
    for (const r of rows) products.set(String(r.code), Number(r.id))
  }

  if (departmentNames.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, name FROM departments
        WHERE name IN (${departmentNames.map(() => '?').join(',')})`,
      departmentNames,
    )
    for (const r of rows) departments.set(String(r.name), Number(r.id))
  }

  return { products, departments }
}

/**
 * A card as somebody defines it.
 *
 * Codes and names rather than ids, because a card is the GROUP's — see the
 * header of listCards. A screen that offers a product picker resolves the
 * chosen row to its code before saving.
 */
export type CardInput = {
  name: string
  isActive: boolean
  requiredStamps: number
  rewardType: LoyaltyCard['rewardType']
  rewardProductCode: string | null
  rewardValue: number
  oneStampPerSale: boolean
  minLineAmount: number
  voucherValidDays: number
  startsOn: string | null
  endsOn: string | null
  productCodes: string[]
  departmentNames: string[]
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

  if (input.rewardType === 'free_item' && !input.rewardProductCode?.trim()) {
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
  for (const code of [...new Set(input.productCodes.map((c) => c.trim()).filter(Boolean))]) {
    await tx.execute(
      'INSERT INTO loyalty_card_items (card_id, product_code) VALUES (?,?)',
      [cardId, code] as never,
    )
  }
  for (const name of [...new Set(input.departmentNames.map((n) => n.trim()).filter(Boolean))]) {
    await tx.execute(
      'INSERT INTO loyalty_card_items (card_id, department_name) VALUES (?,?)',
      [cardId, name] as never,
    )
  }
}

function cardColumns(input: CardInput): unknown[] {
  return [
    input.name.trim(),
    input.isActive ? 1 : 0,
    Math.floor(input.requiredStamps),
    input.rewardType,
    input.rewardType === 'free_item' ? input.rewardProductCode?.trim() || null : null,
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

  const id = await loyaltyTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO loyalty_cards
         (name, is_active, required_stamps, reward_type, reward_product_code, reward_value,
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

  const existing = await loyaltyQueryOne<Row>(siteId, 'SELECT id FROM loyalty_cards WHERE id = ?', [id])
  if (!existing) return { ok: false, error: 'That card no longer exists.' }

  await loyaltyTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE loyalty_cards SET
         name = ?, is_active = ?, required_stamps = ?, reward_type = ?, reward_product_code = ?,
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
  await loyaltyExecute(siteId, 'UPDATE loyalty_cards SET is_active = ? WHERE id = ?', [
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
  // The guard reads the OWNER's stamps; the delete below hits the BRANCH's
  // cards. Two databases when the file is shared, which is exactly why
  // fk_stamp_card had to go in 199 — this check is now what stops a card being
  // deleted out from under progress a customer has earned.
  const used = await loyaltyQueryOne<Row>(
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

  await loyaltyExecute(siteId, 'DELETE FROM loyalty_cards WHERE id = ?', [id])
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
  memberId: number,
): Promise<CardProgress[]> {
  const cards = await listCards(siteId, true)
  if (cards.length === 0) return []

  const counts = await loyaltyQuery<Row>(
    siteId,
    `SELECT card_id, COUNT(*) AS n FROM loyalty_stamps
      WHERE member_id = ? GROUP BY card_id`,
    [memberId],
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
    memberId: number
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
      const result = await loyaltyTransaction(siteId, async (tx) => {
        // Already stamped for this sale? A retry, so nothing to do.
        const [[existing]] = await tx.query<Row[]>(
          `SELECT COUNT(*) AS n FROM loyalty_stamps
            WHERE card_id = ? AND document_id = ? AND member_id = ?
              AND (origin_site_id IS NULL OR origin_site_id = ?)`,
          [card.id, input.documentId, input.memberId, siteId] as never,
        )
        if (Number(existing?.n ?? 0) > 0) return { stamps: 0, codes: [] as string[], points: 0 }

        const [[before]] = await tx.query<Row[]>(
          'SELECT COUNT(*) AS n FROM loyalty_stamps WHERE card_id = ? AND member_id = ? FOR UPDATE',
          [card.id, input.memberId] as never,
        )
        const priorTotal = Number(before?.n ?? 0)
        const priorCompleted = cardCompletions(priorTotal, card.requiredStamps).completed

        const stampIds: number[] = []
        for (let seq = 1; seq <= due; seq++) {
          const [res] = await tx.execute(
            // card_id and document_id are both BRANCH ids, and uq_stamp_sale is
            // built on them — so without the origin, two stores stamping their
            // own sale 5001 collide and the second customer silently gets no
            // stamp. See 200_loyalty_stamp_origin.sql.
            `INSERT INTO loyalty_stamps
               (card_id, member_id, document_id, origin_site_id, stamp_seq, product_id)
             VALUES (?,?,?,?,?,?)`,
            [card.id, input.memberId, input.documentId, siteId, seq, null] as never,
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
            await insertLedger(tx, actor, siteId, {
              memberId: input.memberId,
              entryType: 'adjust',
              points: card.rewardValue,
              documentId: input.documentId,
              documentNumber: input.documentNumber,
              note: `${card.name} completed`,
            })
            points = round(points + card.rewardValue, 4)
          } else {
            const voucher = await issueVoucherTx(tx, actor, {
              memberId: input.memberId,
              rewardType: card.rewardType === 'free_item' ? 'free_item' : 'value',
              rewardProductCode: card.rewardProductCode,
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
          await refreshMember(tx, input.memberId, settings, tiers)
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
  return loyaltyTransaction(siteId, async (tx) => {
    // Scoped by origin throughout. document_id is a BRANCH id, so in a shared
    // stamp table it would match another store's sale — and this function VOIDS
    // vouchers and DELETES stamps, so an unscoped match would wipe progress a
    // customer at a different branch legitimately earned.
    const [issued] = await tx.query<Row[]>(
      `SELECT voucher_id FROM loyalty_stamps
        WHERE document_id = ? AND voucher_id IS NOT NULL
          AND (origin_site_id IS NULL OR origin_site_id = ?)`,
      [documentId, siteId] as never,
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

    const [res] = await tx.execute(
      `DELETE FROM loyalty_stamps
        WHERE document_id = ? AND (origin_site_id IS NULL OR origin_site_id = ?)`,
      [documentId, siteId] as never,
    )
    return (res as { affectedRows: number }).affectedRows
  })
}

/* ── Vouchers ────────────────────────────────────────────────────────────── */

export type VoucherStatus = 'issued' | 'redeemed' | 'expired' | 'void'

export type LoyaltyVoucher = {
  id: number
  code: string
  memberId: number | null
  memberName: string
  memberNumber: string
  rewardType: 'free_item' | 'value'
  rewardProductCode: string | null
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
    memberId: r.member_id === null ? null : Number(r.member_id),
    memberName: String(r.member_name ?? ''),
    memberNumber: String(r.member_number ?? ''),
    rewardType: String(r.reward_type) as 'free_item' | 'value',
    rewardProductCode: (r.reward_product_code as string | null) ?? null,
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

/**
 * A voucher with its customer and reward product.
 *
 * A function rather than a constant because this query straddles the boundary
 * when a group shares its customer file. Vouchers and customers move to the
 * owner; `products` stays in each branch, because the reward is a line off that
 * shop's own shelf. So the query runs against the OWNER and reaches back with
 * `bdb` to name the caller's product table.
 *
 * Both prefixes are empty for a store that owns its own customers, so the SQL
 * is unchanged for every single-store site.
 */
/*
 * Joined to loyalty_members, NOT customers.
 *
 * Left joined to the customer file with a member id this returned a real row
 * and the wrong name — or none at all for a walk-in member, who has no customer
 * row. The silent-wrong-answer shape rather than an error.
 *
 * (Kept outside the template literal: a backtick-quoted table name inside one
 * terminates the string, which is how this first went in and broke the build.)
 */
const selectVoucher = (bdb: string) => `
  SELECT v.id, v.code, v.member_id, v.reward_type, v.reward_product_code, v.reward_value,
         v.description, v.status, v.issued_by, v.expires_on, v.redeemed_at,
         v.redeemed_doc_number, v.created_at,
         m.name AS member_name, m.member_number, p.description AS reward_product_name
    FROM loyalty_vouchers v
    LEFT JOIN loyalty_members m ON m.id = v.member_id
    LEFT JOIN ${bdb}products p ON p.code = v.reward_product_code AND p.is_archived = 0
`

function makeCode(): string {
  let code = ''
  for (let i = 0; i < VOUCHER_CODE_LENGTH; i++) {
    code += VOUCHER_ALPHABET[Math.floor(Math.random() * VOUCHER_ALPHABET.length)]
  }
  return code
}

export type VoucherIssueInput = {
  memberId: number | null
  rewardType: 'free_item' | 'value'
  rewardProductCode?: string | null
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
           (code, member_id, reward_type, reward_product_code, reward_value, description,
            status, issued_by, card_id, expires_on, user_id, user_name)
         VALUES (?,?,?,?,?,?, 'issued', ?,?,?,?,?)`,
        [
          code,
          input.memberId,
          input.rewardType,
          input.rewardType === 'free_item' ? (input.rewardProductCode?.trim() || null) : null,
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
  if (input.rewardType === 'free_item' && !input.rewardProductCode?.trim()) {
    return { ok: false, error: 'Choose the free product.' }
  }

  try {
    const voucher = await loyaltyTransaction(siteId, (tx) => issueVoucherTx(tx, actor, input))

    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: input.memberId,
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
  options: { memberId?: number; spendableOnly?: boolean; limit?: number } = {},
): Promise<LoyaltyVoucher[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.memberId) {
    where.push('v.member_id = ?')
    params.push(options.memberId)
  }
  if (options.spendableOnly) {
    where.push(`v.status = 'issued' AND (v.expires_on IS NULL OR v.expires_on >= CURDATE())`)
  }

  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 200)), 1000)
  const bdb = await loyaltyBranchDbPrefix(siteId)
  const rows = await loyaltyQuery<Row>(
    siteId,
    `${selectVoucher(bdb)} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY v.id DESC LIMIT ${limit}`,
    params,
  )
  return rows.map(mapVoucher)
}

/** Looks a code up for the till. Reserves nothing — this is a preview. */
export async function findVoucher(siteId: number, code: string): Promise<LoyaltyVoucher | null> {
  const bdb = await loyaltyBranchDbPrefix(siteId)
  const row = await loyaltyQueryOne<Row>(
    siteId,
    `${selectVoucher(bdb)} WHERE v.code = ? LIMIT 1`,
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
    `SELECT id, code, member_id, reward_type, reward_product_code, reward_value, description,
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
  const res = await loyaltyExecute(
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
  const res = await loyaltyExecute(
    siteId,
    `UPDATE loyalty_vouchers
        SET status = 'expired'
      WHERE status = 'issued' AND expires_on IS NOT NULL AND expires_on < CURDATE()`,
  )
  return res.affectedRows
}

/** Puts a voucher back when the sale that spent it is reversed. */
export async function restoreVoucherForDocument(siteId: number, documentId: number): Promise<number> {
  const res = await loyaltyExecute(
    siteId,
    `UPDATE loyalty_vouchers
        SET status = 'issued', redeemed_at = NULL, redeemed_doc_id = NULL, redeemed_doc_number = ''
      WHERE redeemed_doc_id = ? AND status = 'redeemed'`,
    [documentId],
  )
  return res.affectedRows
}

/* ── Before the sale opens ───────────────────────────────────────────────── */

export type SpendRequest = {
  /** Rand to settle with points. 0 if points are not being used. */
  points: number
  /** Rand to settle from the wallet. 0 if the wallet is not being used. */
  wallet: number
  voucherCodes: readonly string[]
  settings: LoyaltySettings
}

/**
 * Asks every question that could refuse a loyalty spend, BEFORE the sale opens.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The three spend functions throw, and that throw used to roll the sale back
 * because they ran inside its transaction. Under a shared programme they run
 * against another database, where no transaction reaches. So the refusals are
 * asked here instead, and the sale only opens once they have all passed.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 *
 * It is not a lock. Between this check and the spend, the same member could
 * redeem the same points on another till. The spend functions still hold their
 * FOR UPDATE and still throw, so the money is never double-spent — the second
 * till simply learns about it a moment later than it used to, after the sale
 * has committed rather than before.
 *
 * That residual race is small and one-directional: it needs two tills serving
 * the SAME member within the same second. It is worth naming rather than
 * hiding, because the fix for it — moving the balance somewhere both databases
 * can lock — is the thing this whole design refused to do.
 *
 * Returns the refusal to show the cashier, or null to proceed.
 */
export async function loyaltySpendRefusal(
  siteId: number,
  memberId: number,
  req: SpendRequest,
): Promise<string | null> {
  const member = await loyaltyQueryOne<Row>(
    siteId,
    'SELECT id, is_active, member_number FROM loyalty_members WHERE id = ?',
    [memberId],
  )
  if (!member) return 'That member is no longer on file.'
  if (!Number(member.is_active)) {
    return `Member ${String(member.member_number)} is closed and cannot earn or spend.`
  }

  if (req.points > 0) {
    const { points: balance } = await redeemableFor(siteId, memberId, req.points)
    const needed = randToPoints(req.points, req.settings)

    if (req.settings.minRedeemPoints > 0 && balance < req.settings.minRedeemPoints) {
      return `At least ${req.settings.minRedeemPoints} points are needed to redeem — this member has ${Math.floor(balance)}.`
    }
    if (needed > balance) {
      const worth = pointsToRand(balance, req.settings)
      return `Not enough points: ${Math.floor(balance)} is worth R${worth.toFixed(2)}, and R${req.points.toFixed(2)} was asked for.`
    }
  }

  if (req.wallet > 0) {
    const balance = await getWalletBalance(siteId, memberId)
    if (round(req.wallet, 2) > balance) {
      return `Not enough on the card: R${balance.toFixed(2)} available, R${req.wallet.toFixed(2)} asked for.`
    }
  }

  for (const raw of req.voucherCodes) {
    const code = raw.trim().toUpperCase()
    const voucher = await findVoucher(siteId, code)
    if (!voucher) return `No voucher with code ${code}.`
    if (voucher.status === 'redeemed') return `Voucher ${code} has already been used.`
    if (voucher.status === 'void') return `Voucher ${code} has been cancelled.`
    if (voucher.status === 'expired') return `Voucher ${code} has expired.`
    if (voucher.expiresOn && voucher.expiresOn < localToday()) {
      return `Voucher ${code} expired on ${voucher.expiresOn}.`
    }
    // A voucher belongs to the member it was issued to, and the till must not
    // let one member spend another's. The spend functions never checked this
    // because the sale carried the customer and nobody asked; asking here is
    // free and closes it.
    if (voucher.memberId && voucher.memberId !== memberId) {
      return `Voucher ${code} was issued to another member.`
    }
  }

  return null
}


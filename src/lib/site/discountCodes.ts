import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '@/lib/siteDb'
import { round, toNum } from '@/lib/decimals'

/**
 * Discount codes, and the one function that decides whether one applies.
 *
 * ── validateCode IS THE ONLY AUTHORITY ───────────────────────────────────
 *
 * Checkout calls it to preview a discount, and placePublicOrder calls it AGAIN
 * inside its own transaction to actually apply one. A code validated in a
 * browser is a suggestion; the second call is what decides. Two implementations
 * of "is this code valid" is how a shop discovers an expired code still works
 * because one path forgot to check the date.
 *
 * ── THE ORDER OF OPERATIONS IS FIXED, AND IT MATTERS ─────────────────────
 *
 * goods  →  discount  →  delivery  →  total
 *
 * The discount comes off the GOODS, never the delivery fee (except the
 * free_delivery kind, which does the opposite and touches only the fee). A
 * percentage taken off goods-plus-delivery quietly discounts the driver's time
 * as well, and "10% off" then costs the shop more on a delivered order than a
 * collected one for no reason anyone chose.
 *
 * Delivery thresholds are then computed on the DISCOUNTED goods, because that
 * is what the shopper is actually spending — a R500 free-delivery threshold met
 * only before a R100 discount is a threshold the shopper did not really reach.
 *
 * ── STACKING IS OFF UNLESS A SHOP SAYS OTHERWISE ─────────────────────────
 *
 * A 20% code on top of a 30% special is a 44% discount nobody signed off, and
 * the shop finds out at month end. `combines_with_specials` defaults to 0, and
 * when it is off the already-reduced lines are excluded from the discountable
 * base rather than the whole code being refused — the shopper still gets their
 * discount on everything else, which is what they expect.
 */

type Row = Record<string, unknown>

export type DiscountKind = 'percent' | 'amount' | 'free_delivery'

export type DiscountCode = {
  id: number
  code: string
  description: string
  kind: DiscountKind
  value: number
  minOrderIncl: number
  startsAt: Date | null
  endsAt: Date | null
  maxUses: number | null
  usesCount: number
  maxUsesPerCustomer: number | null
  firstOrderOnly: boolean
  departmentId: number | null
  combinesWithSpecials: boolean
  isActive: boolean
}

/** A basket line, as much of it as a discount needs to see. */
export type DiscountBasketLine = {
  productId: number
  qty: number
  /** The price the storefront is quoting, per unit, VAT inclusive. */
  unitPriceIncl: number
  /** True when a special has already reduced this line. */
  onSpecial: boolean
  /** Which department it is filed in, for a department-scoped code. */
  departmentId: number | null
}

export type DiscountApplication = {
  code: DiscountCode
  /** What comes off the goods. Zero for a free-delivery code. */
  discountIncl: number
  /** Whether the delivery fee is waived. */
  freeDelivery: boolean
  /** Plain-language, shown to the shopper under the field. */
  reason: string
}

export type ValidateResult =
  | { ok: true; application: DiscountApplication }
  | { ok: false; error: string }

function mapCode(r: Row): DiscountCode {
  return {
    id: Number(r.id),
    code: String(r.code ?? ''),
    description: String(r.description ?? ''),
    kind: String(r.kind ?? 'percent') as DiscountKind,
    value: toNum(r.value),
    minOrderIncl: toNum(r.min_order_incl),
    startsAt: asDate(r.starts_at),
    endsAt: asDate(r.ends_at),
    maxUses: r.max_uses === null || r.max_uses === undefined ? null : Number(r.max_uses),
    usesCount: Number(r.uses_count ?? 0),
    maxUsesPerCustomer:
      r.max_uses_per_customer === null || r.max_uses_per_customer === undefined
        ? null
        : Number(r.max_uses_per_customer),
    firstOrderOnly: Number(r.first_order_only) === 1,
    departmentId:
      r.department_id === null || r.department_id === undefined ? null : Number(r.department_id),
    combinesWithSpecials: Number(r.combines_with_specials) === 1,
    isActive: Number(r.is_active) === 1,
  }
}

function asDate(value: unknown): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Normalised the same way everywhere: nobody types a code as it was printed. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().slice(0, 40)
}

/**
 * Validate a code against a basket, and work out what it takes off.
 *
 * `asAt` is threaded rather than read from the clock inside, so a back-dated
 * check and a test can both ask "was this valid then" — the same reasoning as
 * every other dated rule in this codebase.
 */
export async function validateCode(
  siteId: number,
  rawCode: string,
  basket: {
    lines: DiscountBasketLine[]
    deliveryFeeIncl?: number
    /** Signed-in shopper, when there is one. */
    customerId?: number | null
    /** Whatever address the order is being placed against. */
    contactEmail?: string
  },
  asAt: Date = new Date(),
  /** Reads inside a caller's transaction when one is open. */
  tx?: PoolConnection,
): Promise<ValidateResult> {
  const code = normaliseCode(rawCode)
  if (!code) return { ok: false, error: 'Enter a code.' }

  const row = await one(siteId, tx, 'SELECT * FROM discount_codes WHERE code = ?', [code])
  /*
   * "Not recognised" for both a missing code AND an inactive one.
   *
   * Distinguishing them tells someone probing that SAVE20 exists but is
   * switched off, which is the first half of guessing next month's campaign.
   */
  if (!row) return { ok: false, error: "That code isn't recognised." }

  const discount = mapCode(row)
  if (!discount.isActive) return { ok: false, error: "That code isn't recognised." }

  if (discount.startsAt && asAt < discount.startsAt) {
    return { ok: false, error: "That code isn't active yet." }
  }
  if (discount.endsAt && asAt > discount.endsAt) {
    return { ok: false, error: 'That code has expired.' }
  }
  if (discount.maxUses !== null && discount.usesCount >= discount.maxUses) {
    return { ok: false, error: 'That code has been fully used.' }
  }

  const goodsTotal = basket.lines.reduce((sum, l) => sum + l.unitPriceIncl * l.qty, 0)
  if (discount.minOrderIncl > 0 && goodsTotal + 0.005 < discount.minOrderIncl) {
    return {
      ok: false,
      error: `That code needs an order of at least ${money(discount.minOrderIncl)}.`,
    }
  }

  // ── Per-customer limit ────────────────────────────────────────────────
  if (discount.maxUsesPerCustomer !== null) {
    const used = await usesByShopper(siteId, discount.id, basket, tx)
    if (used >= discount.maxUsesPerCustomer) {
      return {
        ok: false,
        error:
          discount.maxUsesPerCustomer === 1
            ? "You've already used that code."
            : `You've used that code the maximum ${discount.maxUsesPerCustomer} times.`,
      }
    }
  }

  // ── New customers only ────────────────────────────────────────────────
  if (discount.firstOrderOnly) {
    const seen = await hasOrderedBefore(siteId, basket, tx)
    if (seen) return { ok: false, error: 'That code is for a first order only.' }
  }

  // ── Free delivery is its own shape ────────────────────────────────────
  if (discount.kind === 'free_delivery') {
    const fee = basket.deliveryFeeIncl ?? 0
    // Accepted even with no fee yet: the shopper may not have entered an
    // address. Refusing here would make a valid code look broken until they do.
    return {
      ok: true,
      application: {
        code: discount,
        discountIncl: 0,
        freeDelivery: true,
        reason: fee > 0 ? 'Delivery is free with this code.' : 'Delivery will be free.',
      },
    }
  }

  // ── What the discount may actually reduce ─────────────────────────────
  const eligible = basket.lines.filter((line) => {
    if (!discount.combinesWithSpecials && line.onSpecial) return false
    if (discount.departmentId !== null && line.departmentId !== discount.departmentId) return false
    return true
  })

  const base = eligible.reduce((sum, l) => sum + l.unitPriceIncl * l.qty, 0)
  if (base <= 0) {
    return {
      ok: false,
      error: discount.departmentId
        ? "That code doesn't apply to anything in your basket."
        : 'That code doesn’t apply to items already on special.',
    }
  }

  const raw =
    discount.kind === 'percent'
      ? (base * discount.value) / 100
      : discount.value

  /*
   * Never more than the goods it applies to.
   *
   * A R100 code on a R60 basket must take off R60, not R100 — the alternative
   * is a negative total, which the order would happily store and the till would
   * then have to explain.
   */
  const amount = round(Math.min(raw, base), 2)
  if (amount <= 0) return { ok: false, error: 'That code takes nothing off this basket.' }

  const partial = eligible.length !== basket.lines.length
  return {
    ok: true,
    application: {
      code: discount,
      discountIncl: amount,
      freeDelivery: false,
      reason: partial
        ? `${money(amount)} off the items this code applies to.`
        : `${money(amount)} off.`,
    },
  }
}

/**
 * Spend the code, in the caller's transaction.
 *
 * ── THIS IS THE CONCURRENCY GUARD ────────────────────────────────────────
 *
 * The row is locked FOR UPDATE and the limit re-checked against the locked
 * value. Two shoppers redeeming the last use of a single-use code in the same
 * instant would otherwise both read `uses_count = 0`, both pass validation, and
 * both be given it — the classic lost update, and the shop honours a code
 * twice.
 *
 * Returns false when the code ran out between validation and here, which the
 * caller turns into a plain "that code has been fully used" rather than a
 * failed order.
 */
export async function redeemCode(
  tx: PoolConnection,
  input: {
    codeId: number
    /** The online order it was spent on — or null for a till sale. */
    orderId?: number | null
    /** The sales document it was spent on — the till's kind of evidence (140). */
    documentId?: number | null
    customerId: number | null
    contactEmail: string
    amountIncl: number
  },
): Promise<boolean> {
  if (!input.orderId && !input.documentId) {
    // A use with nothing to point at is not evidence of anything.
    return false
  }
  const [rows] = await tx.query<never>(
    'SELECT id, max_uses, uses_count FROM discount_codes WHERE id = ? FOR UPDATE',
    [input.codeId] as never,
  )
  const list = rows as unknown as Row[]
  if (list.length === 0) return false

  const maxUses = list[0].max_uses === null ? null : Number(list[0].max_uses)
  const usesCount = Number(list[0].uses_count ?? 0)
  if (maxUses !== null && usesCount >= maxUses) return false

  await tx.execute(
    'UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = ?',
    [input.codeId] as never,
  )
  await tx.execute(
    `INSERT INTO discount_code_uses
       (code_id, order_id, document_id, customer_id, contact_email, amount_incl)
     VALUES (?,?,?,?,?,?)`,
    [
      input.codeId,
      input.orderId ?? null,
      input.documentId ?? null,
      input.customerId,
      input.contactEmail.trim().toLowerCase().slice(0, 190),
      input.amountIncl.toFixed(4),
    ] as never,
  )
  return true
}

/* ── Reading, for the back office ─────────────────────────────────────────── */

export async function listCodes(siteId: number): Promise<DiscountCode[]> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT * FROM discount_codes ORDER BY is_active DESC, code',
  )
  return rows.map(mapCode)
}

export async function getCode(siteId: number, id: number): Promise<DiscountCode | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM discount_codes WHERE id = ?', [id])
  return row ? mapCode(row) : null
}

export type DiscountCodeInput = {
  code: string
  description: string
  kind: DiscountKind
  value: number
  minOrderIncl: number
  startsAt: string | null
  endsAt: string | null
  maxUses: number | null
  maxUsesPerCustomer: number | null
  firstOrderOnly: boolean
  departmentId: number | null
  combinesWithSpecials: boolean
  isActive: boolean
}

export function validateInput(input: DiscountCodeInput): string | null {
  if (!normaliseCode(input.code)) return 'Give the code a word shoppers will type.'
  if (!/^[A-Z0-9._-]+$/.test(normaliseCode(input.code))) {
    return 'A code can only use letters, numbers, dots, dashes and underscores.'
  }
  if (input.kind === 'percent' && (input.value <= 0 || input.value > 100)) {
    return 'A percentage must be between 0 and 100.'
  }
  if (input.kind === 'amount' && input.value <= 0) {
    return 'Give the amount it takes off.'
  }
  if (input.maxUses !== null && input.maxUses < 1) {
    return 'A usage limit must be at least 1, or leave it empty for unlimited.'
  }
  if (input.maxUsesPerCustomer !== null && input.maxUsesPerCustomer < 1) {
    return 'A per-customer limit must be at least 1, or leave it empty.'
  }
  if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
    return 'The end date is before the start date.'
  }
  return null
}

export async function saveCode(
  siteId: number,
  id: number | null,
  input: DiscountCodeInput,
  updatedBy: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const problem = validateInput(input)
  if (problem) return { ok: false, error: problem }

  const code = normaliseCode(input.code)
  const params = [
    code,
    input.description.slice(0, 190),
    input.kind,
    input.value.toFixed(4),
    input.minOrderIncl.toFixed(4),
    input.startsAt,
    input.endsAt,
    input.maxUses,
    input.maxUsesPerCustomer,
    input.firstOrderOnly ? 1 : 0,
    input.departmentId,
    input.combinesWithSpecials ? 1 : 0,
    input.isActive ? 1 : 0,
    updatedBy.slice(0, 120),
  ]

  try {
    if (id) {
      await siteExecute(
        siteId,
        `UPDATE discount_codes
            SET code = ?, description = ?, kind = ?, value = ?, min_order_incl = ?,
                starts_at = ?, ends_at = ?, max_uses = ?, max_uses_per_customer = ?,
                first_order_only = ?, department_id = ?, combines_with_specials = ?,
                is_active = ?, updated_by = ?
          WHERE id = ?`,
        [...params, id],
      )
      return { ok: true, id }
    }

    await siteExecute(
      siteId,
      `INSERT INTO discount_codes
         (code, description, kind, value, min_order_incl, starts_at, ends_at,
          max_uses, max_uses_per_customer, first_order_only, department_id,
          combines_with_specials, is_active, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params,
    )
    const row = await siteQueryOne<Row>(siteId, 'SELECT id FROM discount_codes WHERE code = ?', [
      code,
    ])
    return { ok: true, id: Number(row?.id ?? 0) }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
      return { ok: false, error: `There is already a code called ${code}.` }
    }
    throw error
  }
}

/** How many times this code has been redeemed, and for how much. */
export async function codeStats(
  siteId: number,
  codeId: number,
): Promise<{ uses: number; totalIncl: number }> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT COUNT(*) AS uses, COALESCE(SUM(amount_incl), 0) AS total FROM discount_code_uses WHERE code_id = ?',
    [codeId],
  )
  return { uses: Number(row?.uses ?? 0), totalIncl: toNum(row?.total) }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * How many times this shopper has already spent this code.
 *
 * Matched on the customer id when there is one and on the email otherwise,
 * because a per-customer limit has to work for guests — who are most shoppers
 * on a corner-shop storefront.
 */
async function usesByShopper(
  siteId: number,
  codeId: number,
  basket: { customerId?: number | null; contactEmail?: string },
  tx?: PoolConnection,
): Promise<number> {
  const email = (basket.contactEmail ?? '').trim().toLowerCase()
  if (basket.customerId) {
    const row = await one(
      siteId,
      tx,
      'SELECT COUNT(*) AS n FROM discount_code_uses WHERE code_id = ? AND customer_id = ?',
      [codeId, basket.customerId],
    )
    return Number(row?.n ?? 0)
  }
  if (!email) return 0
  const row = await one(
    siteId,
    tx,
    'SELECT COUNT(*) AS n FROM discount_code_uses WHERE code_id = ? AND contact_email = ?',
    [codeId, email],
  )
  return Number(row?.n ?? 0)
}

/**
 * Whether this shopper has ordered here before.
 *
 * Any online order counts, not only accepted ones: someone whose first order is
 * still sitting in the queue is not a new customer, and letting them spend a
 * first-order code again while it waits is the obvious way to work around one.
 */
async function hasOrderedBefore(
  siteId: number,
  basket: { customerId?: number | null; contactEmail?: string },
  tx?: PoolConnection,
): Promise<boolean> {
  const email = (basket.contactEmail ?? '').trim().toLowerCase()
  if (basket.customerId) {
    const row = await one(
      siteId,
      tx,
      'SELECT 1 AS n FROM online_orders WHERE customer_id = ? LIMIT 1',
      [basket.customerId],
    )
    if (row) return true
  }
  if (!email) return false
  const row = await one(
    siteId,
    tx,
    'SELECT 1 AS n FROM online_orders WHERE LOWER(contact_email) = ? LIMIT 1',
    [email],
  )
  return !!row
}

/** One row, from the caller's transaction when it has one. */
async function one(
  siteId: number,
  tx: PoolConnection | undefined,
  sql: string,
  params: unknown[],
): Promise<Row | null> {
  if (!tx) return siteQueryOne<Row>(siteId, sql, params)
  const [rows] = await tx.query<never>(sql, params as never)
  const list = rows as unknown as Row[]
  return list.length > 0 ? list[0] : null
}

function money(value: number): string {
  return `R${value.toFixed(2)}`
}

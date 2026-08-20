import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { customerQuery, customerQueryOne } from './customerDb'
import { toNum } from '../decimals'
import { toAccountType, type AccountType } from '../accountTypes'
import {
  availableCredit,
  creditBlockedReason,
  headroomRefusal,
  remainingDaily,
  remainingMonthly,
  NO_SPEND,
  type PeriodSpend,
} from '../creditRules'
import { accountSpendFor } from './customerSpend'

/**
 * Finding a customer at the till.
 *
 * Separate from listCustomers for the same reason tillSearch is separate from
 * listProducts: the till asks a different question. Not "show me the debtors
 * book" but "can this person put this sale on their account, right now" — which
 * is one row, resolved fast, with the credit position already worked out.
 *
 * The refusal reasons live here rather than on the screen, so the till and the
 * posting engine cannot disagree about who may buy on credit. salesPosting.ts
 * re-checks the same rules at finalise, because a basket can sit on screen for
 * ten minutes while someone else settles the account.
 */

export type TillCustomer = {
  id: number
  code: string
  name: string
  status: string
  accountType: AccountType
  creditLimit: number
  /** Spend caps over a window. Zero means no limit — see creditRules.ts. */
  dailyLimit: number
  monthlyLimit: number
  balance: number
  /** What is left before the limit is reached. Never negative. */
  availableCredit: number
  overLimit: boolean
  /**
   * What has already been charged to this account today and this month.
   *
   * Carried on the till customer because the Account button has to grey out as
   * the basket grows, and the till is a Client Component that cannot query.
   * Measured once when the customer is attached; the posting engine measures
   * it again at finalise, which is the authoritative read.
   */
  spend: PeriodSpend
  /** What is left of each spend cap. Null where that cap is not set. */
  remainingDaily: number | null
  remainingMonthly: number | null
  paymentTermsDays: number
  vatNumber: string | null
  phone: string | null
  /** Null when the account may be sold to on credit. */
  creditBlockedReason: string | null
  /**
   * ALREADY RESOLVED: the customer's own structure, else the group's, else
   * null meaning "use the site default". Resolved here, once, because every
   * attach flow (POS, invoicing, quotes, jobs) receives a TillCustomer — a
   * second resolver somewhere else is the one that drifts.
   */
  priceStructureId: number | null
  /**
   * ALREADY RESOLVED, the same way and for the same reason as the structure
   * above: the customer's own discount, else the group's, else none. 0 = none.
   *
   * Both halves of "what does this group pay" resolve live, so a renegotiated
   * trade discount is one edit and the counter follows. Still capped per
   * product at its own ceiling when applied — see checkPricing.
   */
  discountPct: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapCustomer(r: Row, spend: PeriodSpend = NO_SPEND): TillCustomer {
  const account = {
    name: String(r.name),
    status: String(r.status),
    accountType: toAccountType(r.account_type),
    creditLimit: toNum(r.credit_limit),
    dailyLimit: toNum(r.daily_limit),
    monthlyLimit: toNum(r.monthly_limit),
    balance: toNum(r.balance),
  }

  return {
    id: Number(r.id),
    code: String(r.code),
    ...account,
    availableCredit: availableCredit(account),
    overLimit: account.balance > account.creditLimit,
    spend,
    remainingDaily: remainingDaily(account, spend),
    remainingMonthly: remainingMonthly(account, spend),
    paymentTermsDays: Number(r.payment_terms_days),
    vatNumber: (r.vat_number as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    creditBlockedReason: creditBlockedReason(account),
    priceStructureId:
      r.price_structure_id !== null && r.price_structure_id !== undefined
        ? Number(r.price_structure_id)
        : r.group_price_structure_id !== null && r.group_price_structure_id !== undefined
          ? Number(r.group_price_structure_id)
          : null,
    // NULL on the customer means "not set", which falls through to the group —
    // an explicit 0 is a decision and stops there. Reading it with toNum()
    // alone would collapse the two and make a group discount unreachable for
    // every account, which is the bug this ternary exists to prevent.
    discountPct:
      r.discount_pct !== null && r.discount_pct !== undefined
        ? toNum(r.discount_pct)
        : toNum(r.group_discount_pct),
  }
}

/* The rules live in lib/creditRules.ts so the till (a Client Component) and the
   posting engine apply the identical test. Re-exported so server callers still
   import one thing. */
export { headroomRefusal, creditBlockedReason, availableCredit }

/**
 * Maps rows, measuring period spend for the accounts that actually have a cap.
 *
 * Only those: a picker showing a hundred customers should not sum a month of
 * tenders for the ninety-odd with no daily or monthly limit set, where the
 * answer cannot change any decision. Accounts without a cap get NO_SPEND,
 * which is the truthful value for "not measured, and nothing depends on it".
 */
async function mapWithSpend(siteId: number, rows: Row[]): Promise<TillCustomer[]> {
  const capped = rows
    .filter((r) => toNum(r.daily_limit) > 0 || toNum(r.monthly_limit) > 0)
    .map((r) => Number(r.id))

  const spend = capped.length > 0 ? await accountSpendFor(siteId, capped) : new Map()
  return rows.map((r) => mapCustomer(r, spend.get(Number(r.id)) ?? NO_SPEND))
}

const SELECT_CUSTOMER = `
  SELECT c.id, c.code, c.name, c.status, c.account_type, c.credit_limit,
         c.daily_limit, c.monthly_limit, c.balance,
         c.payment_terms_days, c.vat_number, c.phone,
         c.price_structure_id, c.discount_pct,
         cg.price_structure_id AS group_price_structure_id,
         cg.default_discount_pct AS group_discount_pct
    FROM customers c
    LEFT JOIN customer_groups cg ON cg.id = c.group_id
`

/**
 * Type-ahead for the till's customer picker.
 *
 * Closed accounts are excluded outright: they are kept for history, and
 * offering one at a till is offering a mistake. On-hold and inactive accounts
 * DO appear — a cashier needs to see why the account is blocked rather than
 * conclude the customer does not exist.
 */
export async function searchCustomersForTill(
  siteId: number,
  term: string,
  limit = 20,
): Promise<TillCustomer[]> {
  const needle = term.trim()
  if (needle.length < 2) return []

  const like = `%${needle}%`
  const capped = Math.min(Math.max(limit, 1), 50)

  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE c.status <> 'closed'
        AND (c.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.loyalty_number = ?)
      ORDER BY
        -- An exact code or loyalty match is what was meant; put it first.
        CASE WHEN c.code = ? OR c.loyalty_number = ? THEN 0 ELSE 1 END,
        c.name ASC
      LIMIT ${capped}`,
    [like, like, like, needle, needle, needle],
  )

  return mapWithSpend(siteId, rows)
}

/**
 * The opening list for a customer picker, before anything is typed.
 *
 * Separate from searchCustomersForTill, which deliberately returns nothing
 * under two characters: the till's picker is a type-ahead on a scanner-driven
 * screen, and firing a hundred-row query every time it opens would be work
 * nobody asked for. A back-office picker is the opposite — it opens with the
 * book in front of you and you scroll or refine.
 *
 * Same status rule as the search, so a customer cannot appear in one and
 * vanish from the other.
 */
export async function listCustomersForPicker(
  siteId: number,
  limit = 100,
): Promise<TillCustomer[]> {
  const capped = Math.min(Math.max(limit, 1), 200)

  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE c.status <> 'closed'
      ORDER BY c.name ASC
      LIMIT ${capped}`,
  )

  return mapWithSpend(siteId, rows)
}

export async function getTillCustomer(
  siteId: number,
  customerId: number,
): Promise<TillCustomer | null> {
  const row = await customerQueryOne<Row>(siteId, `${SELECT_CUSTOMER} WHERE c.id = ? LIMIT 1`, [
    customerId,
  ])
  if (!row) return null
  const [customer] = await mapWithSpend(siteId, [row])
  return customer
}

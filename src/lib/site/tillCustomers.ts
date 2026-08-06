import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import { toAccountType, type AccountType } from '../accountTypes'
import { availableCredit, creditBlockedReason, headroomRefusal } from '../creditRules'

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
  balance: number
  /** What is left before the limit is reached. Never negative. */
  availableCredit: number
  overLimit: boolean
  paymentTermsDays: number
  vatNumber: string | null
  phone: string | null
  /** Null when the account may be sold to on credit. */
  creditBlockedReason: string | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapCustomer(r: Row): TillCustomer {
  const account = {
    name: String(r.name),
    status: String(r.status),
    accountType: toAccountType(r.account_type),
    creditLimit: toNum(r.credit_limit),
    balance: toNum(r.balance),
  }

  return {
    id: Number(r.id),
    code: String(r.code),
    ...account,
    availableCredit: availableCredit(account),
    overLimit: account.balance > account.creditLimit,
    paymentTermsDays: Number(r.payment_terms_days),
    vatNumber: (r.vat_number as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    creditBlockedReason: creditBlockedReason(account),
  }
}

/* The rules live in lib/creditRules.ts so the till (a Client Component) and the
   posting engine apply the identical test. Re-exported so server callers still
   import one thing. */
export { headroomRefusal, creditBlockedReason, availableCredit }

const SELECT_CUSTOMER = `
  SELECT id, code, name, status, account_type, credit_limit, balance,
         payment_terms_days, vat_number, phone
    FROM customers
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

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE status <> 'closed'
        AND (code LIKE ? OR name LIKE ? OR phone LIKE ? OR loyalty_number = ?)
      ORDER BY
        -- An exact code or loyalty match is what was meant; put it first.
        CASE WHEN code = ? OR loyalty_number = ? THEN 0 ELSE 1 END,
        name ASC
      LIMIT ${capped}`,
    [like, like, like, needle, needle, needle],
  )

  return rows.map(mapCustomer)
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

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE status <> 'closed'
      ORDER BY name ASC
      LIMIT ${capped}`,
  )

  return rows.map(mapCustomer)
}

export async function getTillCustomer(
  siteId: number,
  customerId: number,
): Promise<TillCustomer | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_CUSTOMER} WHERE id = ? LIMIT 1`, [
    customerId,
  ])
  return row ? mapCustomer(row) : null
}

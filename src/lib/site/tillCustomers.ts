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
  const structures = await priceStructureTranslation(siteId, rows)
  return rows.map((r) => {
    const mapped = mapCustomer(r, spend.get(Number(r.id)) ?? NO_SPEND)
    return mapped.priceStructureId === null
      ? mapped
      : { ...mapped, priceStructureId: structures.get(mapped.priceStructureId) ?? null }
  })
}

/**
 * Turns the customer file's price-structure ids into THIS store's ids.
 *
 * ── WHY A TRANSLATION AND NOT A LOOKUP ────────────────────────────────────
 *
 * price_structures is per-store (001_products.sql): each shop defines its own
 * list and the ids increment independently. customers.price_structure_id and
 * customer_groups.price_structure_id move to the group primary WITH the
 * customer file, so a branch till reads an id that means something in head
 * office's list and prices against its own.
 *
 * Head office 1=Retail, 2=Wholesale, 3=Staff; branch 1=Retail, 2=Staff. A
 * wholesale customer set up centrally carries id 2 and every sale to them at
 * that branch prices at STAFF rates. Nothing errors and the margin simply
 * disappears. Where the id does not exist at all the till falls back to default
 * pricing — reproduced in probe-shared-customer-accounting.ts, where a
 * primary-only structure resolved to nothing at the branch.
 *
 * ── MATCHED BY NAME, WHICH IS THE ONLY THING THAT TRAVELS ────────────────
 *
 * The same reasoning as product sharing, which matches on CODE for exactly
 * this reason: an auto-increment id identifies a row within one database and
 * nothing across two. price_structures has no code column, so the name is what
 * there is. Compared case-insensitively and trimmed, because "Wholesale" and
 * "wholesale " are the same commercial decision typed by two people.
 *
 * A name with no match at this branch returns null — the site default — which
 * is the same outcome as before and the honest one: this shop does not offer
 * that price structure, so it cannot price at it. Guessing the nearest match
 * would silently sell at a rate nobody chose.
 *
 * Empty map when the store owns its own customers, so every single-store site
 * and every unshared group does no extra work and gets identical ids back.
 */
async function priceStructureTranslation(
  siteId: number,
  rows: Row[],
): Promise<Map<number, number | null>> {
  const wanted = new Set<number>()
  for (const r of rows) {
    const id = r.price_structure_id ?? r.group_price_structure_id
    if (id !== null && id !== undefined) wanted.add(Number(id))
  }
  if (wanted.size === 0) return new Map()

  const { customerOwnerSite } = await import('../storeGroups')
  const owner = await customerOwnerSite(siteId)
  if (owner.siteId === siteId) {
    // Not shared: the ids are already this store's own.
    return new Map([...wanted].map((id) => [id, id]))
  }

  const { siteQuery } = await import('../siteDb')
  const holes = [...wanted].map(() => '?').join(',')
  const [ownerRows, mine] = await Promise.all([
    siteQuery<Row>(
      owner.siteId,
      `SELECT id, name FROM price_structures WHERE id IN (${holes})`,
      [...wanted],
    ),
    siteQuery<Row>(siteId, 'SELECT id, name FROM price_structures'),
  ])

  const byName = new Map(
    mine.map((r) => [String(r.name).trim().toLowerCase(), Number(r.id)]),
  )
  const translation = new Map<number, number | null>()
  for (const r of ownerRows) {
    translation.set(Number(r.id), byName.get(String(r.name).trim().toLowerCase()) ?? null)
  }
  // An id the owner does not have either — a stale reference. Null, not kept.
  for (const id of wanted) if (!translation.has(id)) translation.set(id, null)
  return translation
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

  /*
   * NO LOYALTY CLAUSE. This searches the debtors book, and a card number is not
   * in it.
   *
   * It used to match c.loyalty_number, because a member WAS a customer row. A
   * scanned card now identifies a MEMBER, who may have no account at all — so
   * looking for one here would find nothing for exactly the people who scan
   * most, and looking in another database would make this a mixed query for a
   * result the caller cannot use anyway (a member is not a TillCustomer).
   *
   * findTillMember answers the card. The till attaches the two separately, and
   * attaching a customer pulls their membership along — see PosShell.
   */
  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE c.status <> 'closed'
        AND (c.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)
      ORDER BY
        -- An exact code is what was meant; put it first.
        CASE WHEN c.code = ? THEN 0 ELSE 1 END,
        c.name ASC
      LIMIT ${capped}`,
    [like, like, like, needle],
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

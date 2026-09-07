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
  /**
   * The customer group, for a special that is only for one of them.
   *
   * NOT resolved like the two fields above — this is the group itself rather
   * than something inherited from it, and null means the customer is in none.
   */
  groupId: number | null
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
    groupId: r.group_id === null || r.group_id === undefined ? null : Number(r.group_id),
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
         c.price_structure_id, c.discount_pct, c.group_id,
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

/* ── The offline feed ────────────────────────────────────────────────────── */

/**
 * Ceiling on one customer feed.
 *
 * Smaller than the product limit (50,000) and for a different reason. A product
 * file is what a till SELLS FROM, and a shop past that limit cannot trade
 * offline at all; a customer file is an attachment to a sale, and a till that
 * holds none still takes every cash sale it took before this existed. So this is
 * sized to "the debtors book a counter actually recognises" rather than to
 * "everything".
 *
 * A shop past it gets NO customers offline rather than a partial book — see
 * `customersForTill`, which refuses rather than truncating. A silently truncated
 * book is the worst outcome available: the cashier searches, finds nothing, and
 * concludes the customer is not on the system.
 */
export const OFFLINE_CUSTOMER_LIMIT = 20_000

/**
 * A customer as a till holds it with no network.
 *
 * ── WHY NOT SIMPLY `TillCustomer` ─────────────────────────────────────────
 *
 * Because the credit half is CONDITIONAL, and a shape that always carries
 * `balance: number` cannot say "not shipped". Zero is a real credit position —
 * `creditBlockedReason` reads a zero limit as "no credit granted" — so a till
 * that received zeros because its shop never opted in would show the cashier a
 * confident, wrong answer instead of falling back to the server.
 *
 * `credit` being ABSENT is therefore load-bearing. It means the shop has not
 * turned on `pos_offline_account_sales`, the debtors figures never left the
 * server, and the till must not pretend to know them. See `offlineCustomer()`
 * in lib/posOffline/customers.ts, the only thing that turns one of these back
 * into a `TillCustomer`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * Email, address, notes, the rep, the statement cycle. None of it appears on a
 * slip or changes what may be sold, and the header of /api/pos/catalog makes the
 * argument in full: what ships is enough to put a name on a slip, price a trade
 * account correctly, and — where the shop asked for it — decide whether credit
 * may be extended. Nothing more.
 */
export type OfflineCustomer = {
  id: number
  code: string
  name: string
  /** Never `closed` — those are excluded from the feed entirely. */
  status: string
  accountType: AccountType
  paymentTermsDays: number
  vatNumber: string | null
  phone: string | null
  /** ALREADY TRANSLATED to this store's own ids — see priceStructureTranslation. */
  priceStructureId: number | null
  discountPct: number
  groupId: number | null
  /**
   * The debtors figures, present ONLY where the shop allows offline account
   * sales. Absent is not "zero"; it is "the till was never told".
   */
  credit?: {
    creditLimit: number
    dailyLimit: number
    monthlyLimit: number
    balance: number
    spend: PeriodSpend
  }
}

/** Whether a status may be sold to at all. Closed accounts never ship. */
const FEED_STATUS = "c.status <> 'closed'"

/**
 * How many customers a full feed would hold.
 *
 * The counterpart of `tillCatalogTotal` for products, and it exists for exactly
 * the same reason: a till whose one full load came back short can never fill the
 * gap from deltas alone, because the missing rows predate every cursor that
 * follows.
 *
 * It is also the ONLY defence against a hard delete. `customers.ts` really does
 * `DELETE FROM customers` for an account that never traded, and a vanished row
 * leaves no `updated_at` behind for any delta to find.
 */
export async function tillCustomerTotal(siteId: number): Promise<number> {
  const row = await customerQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM customers c WHERE ${FEED_STATUS}`,
  )
  return Number(row?.n ?? 0)
}

/**
 * Customers the till should forget: closed since the cursor.
 *
 * Closing is the SOFT path and the only one a delta can see. A hard delete is
 * covered by the count audit instead — a blunter instrument, costing one extra
 * full load, but the only one available for a row that is simply gone.
 */
export async function customersClosedSince(siteId: number, cutoff: string): Promise<number[]> {
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT id FROM customers
      WHERE updated_at >= ? - INTERVAL 60 SECOND
        AND status = 'closed'`,
    [cutoff],
  ).catch(() => [])
  return rows.map((r) => Number(r.id))
}

/**
 * The customer file a till trades on with no network.
 *
 * ── THE DELTA IS KEYED ON `updated_at`, AND THE SPEND RIDES ALONG ─────────
 *
 * Period spend is not a column — it is a SUM over `sales_tenders` — so a naive
 * reading says a products-style delta would ship a stale figure, exactly as it
 * would have for prices (`pricesChangedSince` exists for that fault).
 *
 * It does not, and the reason is worth stating because it is not obvious.
 * Anything that moves an account's spend also moves its BALANCE: both are driven
 * by tenders that post to the debtor, and `customers.balance` is denormalised on
 * the row with ON UPDATE CURRENT_TIMESTAMP. So a customer whose spend changed is
 * a customer whose row changed, and the delta carries them. A settlement moves
 * the balance without moving the spend, which sends a row that did not need
 * sending — harmless, and the right direction to be wrong in.
 *
 * ── AND THE CURSOR COMES FROM THE CALLER'S DATABASE ───────────────────────
 *
 * Under a shared customer file these rows live in the group primary's database
 * rather than the caller's, while `since` was minted from the caller's NOW().
 * Comparable because sharing REQUIRES one MariaDB instance (015) — the same
 * precondition `accountSpendFor` leans on to fan out across members. Were that
 * ever relaxed, this comparison is one of the things that breaks silently.
 */
export async function customersForTill(
  siteId: number,
  options: { cutoff: string | null; withCredit: boolean },
): Promise<{ customers: OfflineCustomer[]; total: number; overLimit: boolean }> {
  const total = await tillCustomerTotal(siteId)

  /*
   * Past the ceiling: no customers, rather than the first 20,000 by name.
   *
   * A truncated book is worse than an empty one. With none, the till knows it
   * has none and says so; with the A-to-K of a book that runs to Z, a cashier
   * searches for Zulu, finds nothing, concludes the account does not exist, and
   * rings the sale up as cash.
   */
  if (total > OFFLINE_CUSTOMER_LIMIT) return { customers: [], total, overLimit: true }

  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER}
      WHERE ${FEED_STATUS}
        ${options.cutoff ? 'AND c.updated_at >= ? - INTERVAL 60 SECOND' : ''}
      ORDER BY c.name ASC
      LIMIT ${OFFLINE_CUSTOMER_LIMIT}`,
    options.cutoff ? [options.cutoff] : [],
  )

  /*
   * Through `mapWithSpend`, the same function the online picker uses, rather
   * than a second projection of the same columns. That is the whole reason this
   * lives beside the online reads instead of in the route: the offline row and
   * the online row must not be able to disagree about a customer's price
   * structure or discount, and a copy is what drifts.
   *
   * It measures spend only for accounts that actually carry a cap, so a book of
   * 20,000 with a dozen capped accounts costs a dozen accounts' worth of SUM.
   */
  const mapped = await mapWithSpend(siteId, rows)

  return {
    customers: mapped.map((c) => project(c, options.withCredit)),
    total,
    overLimit: false,
  }
}

/**
 * Strips a `TillCustomer` down to what may leave the building.
 *
 * The DERIVED fields — availableCredit, overLimit, remainingDaily,
 * remainingMonthly, creditBlockedReason — are deliberately not sent even when
 * credit is. They are pure functions of the four figures beside them, and a till
 * that received both could hold a position whose halves disagree. The till
 * recomputes them from the same `creditRules` the server used, which is the
 * arrangement that makes the two sides agree by construction rather than by
 * both being careful.
 */
function project(customer: TillCustomer, withCredit: boolean): OfflineCustomer {
  const base: OfflineCustomer = {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    status: customer.status,
    accountType: customer.accountType,
    paymentTermsDays: customer.paymentTermsDays,
    vatNumber: customer.vatNumber,
    phone: customer.phone,
    priceStructureId: customer.priceStructureId,
    discountPct: customer.discountPct,
    groupId: customer.groupId,
  }
  if (!withCredit) return base
  return {
    ...base,
    credit: {
      creditLimit: customer.creditLimit,
      dailyLimit: customer.dailyLimit,
      monthlyLimit: customer.monthlyLimit,
      balance: customer.balance,
      spend: customer.spend,
    },
  }
}

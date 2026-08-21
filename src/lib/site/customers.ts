import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { customerOwnerSite } from '../storeGroups'
import { toNum } from '../decimals'
import {
  toAccountType,
  allowsCredit,
  DEFAULT_ACCOUNT_TYPE,
  type AccountType,
} from '../accountTypes'
import { toStatementCycle, type StatementCycle } from '../statementCycles'
import { isEmail } from './customerLookups'
import { resolveMasterCode } from './masterCodes'
import { logActivity, type Actor } from './activityLog'
import { removeDocumentsFor } from './partyDocuments'
import { removeCommentsFor } from './partyComments'
import { deleteStoredFile } from '../uploads'

/**
 * Customers — the debtors book.
 *
 * `balance` is readable here but never writable: it moves only through posted
 * transactions, in the same database transaction as the ledger row that moves
 * it. updateCustomer() deliberately omits it from its column list. Until the
 * sub-ledger lands it reads 0 for every account, which is correct — nothing
 * has been posted.
 */

export const CUSTOMER_STATUSES = ['active', 'on_hold', 'inactive', 'closed'] as const
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]

/** Statuses a customer may still be sold to on account. */
const TRADING_STATUSES: readonly CustomerStatus[] = ['active']

export type Customer = {
  id: number
  code: string
  name: string
  status: CustomerStatus
  statusReason: string | null
  accountType: AccountType
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  vatNumber: string | null
  loyaltyNumber: string | null
  groupId: number | null
  groupName: string | null
  repId: number | null
  repName: string | null
  category: string | null
  paymentTermsDays: number
  creditLimit: number
  /**
   * Spend caps over a window. Zero means NO limit, which is the opposite of
   * creditLimit above — a limit is a grant, a cap is a restriction. See the
   * header of 175_customer_spend_limits.sql.
   */
  dailyLimit: number
  monthlyLimit: number
  /** Email every finalised invoice to this account, without being asked. */
  autoEmailInvoices: boolean
  balance: number
  /** This account's own structure. Null = the group's, else the site default. */
  priceStructureId: number | null
  /** Standing discount applied as the default line discount. Null = none. */
  discountPct: number | null
  /** Annual nominal rate. Zero means the group's default applies, if it has one. */
  interestRatePct: number
  /** Explicit opt-in, separate from the rate — see interestRules.ts on the NCA. */
  interestEnabled: boolean
  interestGraceDays: number
  /**
   * How often this account is statemented, and from when.
   *
   * The cycle decides two things a statement cannot work out for itself: which period
   * "this statement" covers, and how wide each rung of the age ladder is. A weekly
   * account is not a monthly one read more often — thirty days late is four cycles gone
   * rather than one, and `bucketFor` takes the width for exactly that reason.
   *
   * `statementAnchorDate` pins where a 7- or 14-day cycle starts counting from;
   * `statementAnchorDay` is the day-of-month a monthly one closes on. Both are
   * meaningless for the other cycle and are left at their defaults there.
   */
  statementCycle: StatementCycle
  statementAnchorDay: number
  statementAnchorDate: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  /** Derived, never stored — a zero limit means "no credit granted", not "unlimited". */
  overLimit: boolean
  availableCredit: number
  /** Whether a sale may be put on this account right now. */
  canBuyOnAccount: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapCustomer(r: Row): Customer {
  const creditLimit = toNum(r.credit_limit)
  const balance = toNum(r.balance)
  const status = String(r.status) as CustomerStatus
  const accountType = toAccountType(r.account_type)
  const overLimit = balance > creditLimit

  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    status,
    statusReason: (r.status_reason as string | null) ?? null,
    accountType,
    contactName: (r.contact_name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    addressLine1: (r.address_line1 as string | null) ?? null,
    addressLine2: (r.address_line2 as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    postalCode: (r.postal_code as string | null) ?? null,
    vatNumber: (r.vat_number as string | null) ?? null,
    loyaltyNumber: (r.loyalty_number as string | null) ?? null,
    groupId: r.group_id === null ? null : Number(r.group_id),
    groupName: (r.group_name as string | null) ?? null,
    repId: r.rep_id === null ? null : Number(r.rep_id),
    repName: (r.rep_name as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    paymentTermsDays: Number(r.payment_terms_days),
    creditLimit,
    dailyLimit: toNum(r.daily_limit),
    monthlyLimit: toNum(r.monthly_limit),
    autoEmailInvoices: !!r.auto_email_invoices,
    balance,
    priceStructureId:
      r.price_structure_id === null || r.price_structure_id === undefined
        ? null
        : Number(r.price_structure_id),
    discountPct:
      r.discount_pct === null || r.discount_pct === undefined ? null : toNum(r.discount_pct),
    interestRatePct: toNum(r.interest_rate_pct),
    interestEnabled: Boolean(r.interest_enabled),
    interestGraceDays: Number(r.interest_grace_days ?? 0),
    // Narrowed rather than cast: the column is an ENUM, but a row written before 065
    // ran holds NULL, and `toStatementCycle` answers 'monthly' for anything it does not
    // recognise — which is the right default and the one the settings default matches.
    statementCycle: toStatementCycle(r.statement_cycle),
    statementAnchorDay: Number(r.statement_anchor_day ?? 0),
    statementAnchorDate: r.statement_anchor_date
      ? String(r.statement_anchor_date).slice(0, 10)
      : null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    overLimit,
    availableCredit: Math.max(creditLimit - balance, 0),
    canBuyOnAccount:
      TRADING_STATUSES.includes(status) && allowsCredit(accountType) && creditLimit > 0 && !overLimit,
  }
}

/* ── Which database holds these customers ─────────────────────────────────
 *
 * A store group may share one customer file, in which case every branch reads
 * and writes the group primary's database rather than its own — see
 * customerOwnerSite() in lib/storeGroups.ts. With no sharing configured the
 * owner IS the caller, so these wrappers are an identity function.
 *
 * customer_groups is joined by SELECT_CUSTOMER below and resolves correctly:
 * groups move to the owner alongside customers.
 *
 * sales_reps is NOT joined there any more, and the claim that used to sit here —
 * "reps are replicated into every store" — was false. Nothing fans them out;
 * the only INSERT writes to the caller's own database. So a rep_id was a branch
 * id being resolved against the owner's rep list. The customer now carries
 * rep_name, matched the way departments and price structures are (205).
 *
 * ── ONE THING DOES NOT FOLLOW THE CUSTOMER ───────────────────────────────
 *
 * activity_log stays in the BRANCH. It records what people did — every entity,
 * not just customers — so it belongs where the person was, and "who put this
 * account on hold" is answered per store rather than pooled.
 *
 * That means an audit line can no longer be written inside the same transaction
 * as the customer row, because they are in different databases. logActivity()
 * is used instead of logActivityTx(): it is the same write, outside the
 * transaction, and it already swallows its own errors so a failed audit line
 * cannot roll back a saved customer. The trade is deliberate and small — the
 * customer row is the fact, the log line is the note about it.
 */

async function ownerSite(siteId: number): Promise<number> {
  return (await customerOwnerSite(siteId)).siteId
}

async function customerQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return siteQuery<T>(await ownerSite(siteId), sql, params)
}

async function customerQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return siteQueryOne<T>(await ownerSite(siteId), sql, params)
}

async function customerTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
): Promise<T> {
  return siteTransaction(await ownerSite(siteId), fn)
}

const SELECT_CUSTOMER = `
  SELECT c.id, c.code, c.name, c.status, c.status_reason, c.account_type,
         c.contact_name, c.email, c.phone, c.address_line1, c.address_line2,
         c.city, c.postal_code, c.vat_number, c.loyalty_number,
         c.group_id, c.rep_id, c.category, c.payment_terms_days,
         c.credit_limit, c.daily_limit, c.monthly_limit, c.auto_email_invoices,
         c.balance, c.price_structure_id, c.discount_pct,
         c.interest_rate_pct, c.interest_enabled, c.interest_grace_days,
         c.statement_cycle, c.statement_anchor_day, c.statement_anchor_date,
         c.notes, c.created_at, c.updated_at,
         g.name AS group_name,
         -- From the customer, not joined: sales_reps stays per-store while this
         -- query may run against the group primary, so the join printed the
         -- owner's rep of that id — a different person, or nobody. See 205.
         c.rep_name AS rep_name
    FROM customers c
    LEFT JOIN customer_groups g ON g.id = c.group_id
`

export type CustomerSort = 'name' | 'code' | 'balance' | 'created'

export type CustomerListOptions = {
  search?: string
  /** Empty or omitted means every status EXCEPT closed — see the note below. */
  statuses?: readonly CustomerStatus[]
  groupId?: number
  repId?: number
  /**
   * The rep's NAME, resolved from repId by the caller.
   *
   * Set internally, not by screens: buildWhere is sync and cannot look it up,
   * and the name is the only form that survives a shared customer file (205).
   */
  repName?: string | null
  category?: string
  /** Only accounts with a non-zero balance. */
  withBalanceOnly?: boolean
  /** Only accounts past their credit limit. */
  overLimitOnly?: boolean
  /**
   * Only rows changed on or after this instant — the /api/v1 sync cursor.
   * updated_at is ON UPDATE CURRENT_TIMESTAMP, so every save moves it.
   */
  updatedSince?: Date
  sort?: CustomerSort
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * Fills in repName from repId, so the sync buildWhere below can filter by name.
 *
 * Every list path goes through this. Skipped when there is no rep filter, so
 * the ordinary list costs nothing extra.
 */
async function withRepName(
  siteId: number,
  opts: CustomerListOptions,
): Promise<CustomerListOptions> {
  if (!opts.repId || opts.repName !== undefined) return opts
  return { ...opts, repName: await repNameFor(siteId, opts.repId) }
}

function buildWhere(opts: CustomerListOptions): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.statuses?.length) {
    where.push(`c.status IN (${opts.statuses.map(() => '?').join(',')})`)
    params.push(...opts.statuses)
  } else {
    // A closed account is finished with; showing it by default would bury the
    // live book under years of history. It is still one filter click away.
    where.push("c.status <> 'closed'")
  }

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push(
      '(c.name LIKE ? OR c.code LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.contact_name LIKE ? OR c.loyalty_number = ?)',
    )
    params.push(term, term, term, term, term, opts.search.trim())
  }

  if (opts.groupId) {
    where.push('c.group_id = ?')
    params.push(opts.groupId)
  }
  // By name, for the reason given on rep_name in the SELECT above. The name is
  // resolved by the caller, which has the siteId and can await — this helper is
  // sync. A rep id naming nobody here matches a name that cannot exist, so the
  // report comes back empty rather than silently widening to every account.
  if (opts.repId) {
    where.push('c.rep_name = ?')
    params.push(opts.repName ?? ' no-such-rep')
  }
  if (opts.category?.trim()) {
    where.push('c.category = ?')
    params.push(opts.category.trim())
  }
  if (opts.updatedSince) {
    where.push('c.updated_at >= ?')
    params.push(opts.updatedSince)
  }
  if (opts.withBalanceOnly) where.push('c.balance <> 0')
  // Mirrors the derived overLimit exactly. Kept as SQL rather than filtering in
  // JS so the count and the page agree — filtering after LIMIT would report a
  // total that does not match the rows.
  if (opts.overLimitOnly) where.push('c.balance > c.credit_limit')

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

const SORT_COLUMNS: Record<CustomerSort, string> = {
  name: 'c.name',
  code: 'c.code',
  balance: 'c.balance',
  created: 'c.created_at',
}

export async function listCustomers(
  siteId: number,
  opts: CustomerListOptions = {},
): Promise<{ items: Customer[]; total: number }> {
  const { sql: whereSql, params } = buildWhere(await withRepName(siteId, opts))

  // Clamped, then interpolated: mysql2 rejects LIMIT/OFFSET as placeholders.
  // Safe only because both are numbers that have been through Math.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const column = SORT_COLUMNS[opts.sort ?? 'name']
  const direction = opts.direction === 'desc' ? 'DESC' : 'ASC'

  const [rows, countRow] = await Promise.all([
    customerQuery<Row>(
      siteId,
      `${SELECT_CUSTOMER} ${whereSql}
        ORDER BY ${column} ${direction}, c.id ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    customerQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total FROM customers c ${whereSql}`,
      params,
    ),
  ])

  return { items: rows.map(mapCustomer), total: Number(countRow?.total ?? 0) }
}

/** Headline figures for the list screen's tiles, over the WHOLE book. */
export type CustomerSummary = {
  total: number
  owing: number
  totalOwed: number
  overLimit: number
  onHold: number
}

export async function customerSummary(siteId: number): Promise<CustomerSummary> {
  const row = await customerQueryOne<Row>(
    siteId,
    `SELECT COUNT(*)                                                  AS total,
            SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END)              AS owing,
            COALESCE(SUM(CASE WHEN balance > 0 THEN balance END), 0)  AS total_owed,
            SUM(CASE WHEN balance > credit_limit THEN 1 ELSE 0 END)   AS over_limit,
            SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END)       AS on_hold
       FROM customers
      WHERE status <> 'closed'`,
  )

  return {
    total: Number(row?.total ?? 0),
    owing: Number(row?.owing ?? 0),
    totalOwed: toNum(row?.total_owed),
    overLimit: Number(row?.over_limit ?? 0),
    onHold: Number(row?.on_hold ?? 0),
  }
}

export async function getCustomer(siteId: number, id: number): Promise<Customer | null> {
  const row = await customerQueryOne<Row>(siteId, `${SELECT_CUSTOMER} WHERE c.id = ? LIMIT 1`, [id])
  return row ? mapCustomer(row) : null
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type CustomerInput = {
  code: string
  name: string
  status?: CustomerStatus
  statusReason?: string | null
  accountType?: AccountType
  contactName?: string | null
  email?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  postalCode?: string | null
  vatNumber?: string | null
  loyaltyNumber?: string | null
  groupId?: number | null
  repId?: number | null
  category?: string | null
  paymentTermsDays?: number
  creditLimit?: number
  /** Spend caps over a window. Zero means no limit — see the Customer type. */
  dailyLimit?: number
  monthlyLimit?: number
  autoEmailInvoices?: boolean
  /** This account's own structure. Null falls back to group, then site. */
  priceStructureId?: number | null
  /** Standing discount, capped per product at application time. Null = none. */
  discountPct?: number | null
  /** Annual nominal rate. Zero means fall back to the group's default. */
  interestRatePct?: number
  /** Explicit opt-in — see the NCA note in interestRules.ts. */
  interestEnabled?: boolean
  interestGraceDays?: number
  /** See the note on `Customer.statementCycle`. Defaults to monthly. */
  statementCycle?: StatementCycle
  statementAnchorDay?: number
  statementAnchorDate?: string | null
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

export function validateCustomer(input: CustomerInput): string | null {
  if (!input.code?.trim()) return 'A customer code is required.'
  if (input.code.trim().length > 32) return 'Customer code must be 32 characters or fewer.'
  if (!input.name?.trim()) return 'A customer name is required.'
  if (input.name.trim().length > 160) return 'Name must be 160 characters or fewer.'
  if (input.email?.trim() && !isEmail(input.email.trim())) {
    return 'That email address does not look valid.'
  }
  if ((input.creditLimit ?? 0) < 0) return 'Credit limit cannot be negative.'
  if ((input.dailyLimit ?? 0) < 0) return 'A daily limit cannot be negative.'
  if ((input.monthlyLimit ?? 0) < 0) return 'A monthly limit cannot be negative.'
  // A daily cap above the monthly one can never bind, so it is almost always a
  // typo — and the one reading it would never know which figure was wrong.
  if (
    (input.dailyLimit ?? 0) > 0 &&
    (input.monthlyLimit ?? 0) > 0 &&
    (input.dailyLimit ?? 0) > (input.monthlyLimit ?? 0)
  ) {
    return 'The daily limit cannot be more than the monthly limit.'
  }
  // Auto-emailing needs somewhere to send to. Accepting the switch without an
  // address would fail silently on every invoice, which is the worst of both.
  if (input.autoEmailInvoices && !input.email?.trim()) {
    return 'Give the account an email address before switching on automatic invoices.'
  }
  if (input.discountPct !== null && input.discountPct !== undefined) {
    if (input.discountPct < 0 || input.discountPct > 100) {
      return 'A standing discount must be between 0 and 100 percent.'
    }
  }
  if ((input.interestRatePct ?? 0) < 0) return 'An interest rate cannot be negative.'
  // Not the NCA ceiling — that depends on the repo rate and the agreement type,
  // neither of which this system knows. A sanity bound only, to catch 1550 typed
  // for 15.50. See the note at the top of interestRules.ts.
  if ((input.interestRatePct ?? 0) > 100) return 'That interest rate looks wrong — enter it as a yearly percentage.'
  if ((input.interestGraceDays ?? 0) < 0 || (input.interestGraceDays ?? 0) > 365) {
    return 'The grace period must be between 0 and 365 days.'
  }
  if ((input.paymentTermsDays ?? 0) < 0 || (input.paymentTermsDays ?? 0) > 365) {
    return 'Payment terms must be between 0 and 365 days.'
  }
  // A blocked account with no stated reason is the thing staff complain about
  // most: the badge says "on hold" and nobody knows why.
  if (input.status && input.status !== 'active' && !input.statusReason?.trim()) {
    return 'Give a reason when an account is not active.'
  }
  return null
}

/**
 * A rep id in THIS store's sales_reps, as a name.
 *
 * siteQuery, not customerQuery: sales_reps does not travel with the customer
 * file, so an id a caller holds is always this store's and resolving it against
 * the owner is the bug 205 exists to fix.
 *
 * Exported for aging.ts and any other module that has to translate one.
 */
export async function repNameFor(siteId: number, repId: number | null): Promise<string | null> {
  if (!repId) return null
  try {
    const { siteQueryOne } = await import('../siteDb')
    const row = await siteQueryOne<RowDataPacket & { name: string }>(
      siteId,
      'SELECT name FROM sales_reps WHERE id = ? LIMIT 1',
      [repId],
    )
    return row ? String(row.name) : null
  } catch {
    return null
  }
}

/* ── Might this person already be on file? ────────────────────────────────
 *
 * The customer CODE is unique and createCustomer refuses a repeat outright —
 * that is a fact about the database, and there is nothing to decide.
 *
 * A repeated cell number or email address is different. It is a STRONG HINT
 * and not an error, because both are legitimately shared: a husband and wife on
 * one mobile, a father and son at one shop, two departments of one company
 * billed separately through one switchboard address. Refusing those would make
 * the system wrong about real customers, and staff would work around it by
 * typing a fake number — which destroys the very signal this is built on.
 *
 * So it warns, names what it matched, and lets the person decide. The decision
 * is theirs because they are the one standing in front of the customer.
 *
 * ── WHY AT CREATION AND NOT AS A MERGE TOOL ──────────────────────────────
 *
 * A duplicate caught here costs nothing to resolve: nobody has a balance, a
 * ledger, loyalty points or a statement yet. The same duplicate found in six
 * months is a merge, and merging two customers means merging two running
 * totals and the audit trail of both — a ledger event, not a data cleanup.
 * This is the cheap end of the same problem.
 */

export type DuplicateMatch = {
  id: number
  code: string
  name: string
  /** Which field matched. Both when the same account matches on both. */
  matchedOn: ('phone' | 'email')[]
}

/**
 * Digits only, last nine.
 *
 * Phone numbers are stored exactly as typed — there is no normalisation on
 * write — so "082 123 4567", "0821234567" and "+27 82 123 4567" are three
 * different strings for one phone. Comparing them raw would miss most real
 * duplicates, which is the whole point of the check.
 *
 * Last NINE digits, because that is what survives the two ways a South African
 * number gets written: the local form drops the country code and keeps a
 * leading 0 (0821234567 → 821234567), and the international form drops the 0
 * and adds 27 (+27821234567 → 821234567). Both land on the same nine.
 *
 * Returns null below nine digits — an extension or a partial number, which
 * would match far too much. Long numbers keep their last nine, so a stray
 * prefix does not defeat the comparison.
 */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length >= 9 ? digits.slice(-9) : null
}

/**
 * Existing accounts that share this one's cell number or email address.
 *
 * Reads through customerQuery, so under a shared customer file it looks in the
 * group's book rather than the branch's own. A local check would find nothing
 * and cheerfully create the duplicate it exists to prevent — the same class of
 * mistake as the opening-balance and spend-limit findings.
 *
 * `excludeId` skips the account being edited, so saving a customer without
 * changing anything cannot warn about itself.
 *
 * The phone comparison happens in SQL on the last nine digits, so it uses no
 * index — deliberate, and bounded: it runs once when somebody presses Save on
 * a customer form, not on any list or till path. The email side is an indexed
 * equality on the already-lowercased column.
 */
export async function possibleDuplicates(
  siteId: number,
  input: { phone?: string | null; email?: string | null },
  excludeId?: number,
): Promise<DuplicateMatch[]> {
  const phone = phoneKey(input.phone)
  const email = input.email?.trim().toLowerCase() || null
  if (!phone && !email) return []

  const clauses: string[] = []
  const params: unknown[] = []

  if (phone) {
    // RIGHT(digits-only, 9) — the same key phoneKey() builds, computed in SQL.
    clauses.push(
      `(c.phone IS NOT NULL AND c.phone <> '' AND RIGHT(REGEXP_REPLACE(c.phone, '[^0-9]', ''), 9) = ?)`,
    )
    params.push(phone)
  }
  if (email) {
    clauses.push('(c.email IS NOT NULL AND c.email = ?)')
    params.push(email)
  }

  let sql = `SELECT c.id, c.code, c.name, c.phone, c.email
               FROM customers c
              WHERE (${clauses.join(' OR ')})`
  if (excludeId) {
    sql += ' AND c.id <> ?'
    params.push(excludeId)
  }
  // A closed account is finished with; warning about one would send somebody to
  // a record they cannot use. Still bounded, because a shared book is large.
  sql += " AND c.status <> 'closed' ORDER BY c.name LIMIT 5"

  const rows = await customerQuery<Row>(siteId, sql, params)

  return rows.map((r) => {
    const matchedOn: DuplicateMatch['matchedOn'] = []
    // Recomputed per row rather than trusted from the WHERE: with both fields
    // supplied the query is an OR, so a row may have matched on either, and the
    // message has to say which.
    if (phone && phoneKey(r.phone as string | null) === phone) matchedOn.push('phone')
    if (email && String(r.email ?? '').toLowerCase() === email) matchedOn.push('email')
    return {
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      matchedOn,
    }
  })
}

/** The sentence shown to the person saving. Named so the wording lives in one place. */
export function duplicateWarning(matches: DuplicateMatch[]): string {
  if (matches.length === 0) return ''

  const describe = (m: DuplicateMatch) => {
    const on =
      m.matchedOn.length === 2
        ? 'same cell number and email'
        : m.matchedOn[0] === 'phone'
          ? 'same cell number'
          : 'same email'
    return `${m.code} — ${m.name} (${on})`
  }

  return matches.length === 1
    ? `This might already be on file: ${describe(matches[0])}. Save anyway to create a separate account.`
    : `This might already be on file: ${matches.map(describe).join('; ')}. ` +
        'Save anyway to create a separate account.'
}

/** Columns written by both create and update, in one place so they cannot drift. */
function writableColumns(input: CustomerInput, repName: string | null): unknown[] {
  return [
    input.code.trim(),
    input.name.trim(),
    input.status ?? 'active',
    input.statusReason?.trim() || null,
    input.accountType ?? DEFAULT_ACCOUNT_TYPE,
    input.contactName?.trim() || null,
    input.email?.trim().toLowerCase() || null,
    input.phone?.trim() || null,
    input.addressLine1?.trim() || null,
    input.addressLine2?.trim() || null,
    input.city?.trim() || null,
    input.postalCode?.trim() || null,
    input.vatNumber?.trim() || null,
    input.loyaltyNumber?.trim() || null,
    input.groupId ?? null,
    input.repId ?? null,
    repName,
    input.category?.trim() || null,
    input.paymentTermsDays ?? 30,
    (input.creditLimit ?? 0).toFixed(4),
    (input.dailyLimit ?? 0).toFixed(4),
    (input.monthlyLimit ?? 0).toFixed(4),
    input.autoEmailInvoices ?? false,
    input.priceStructureId ?? null,
    input.discountPct === null || input.discountPct === undefined
      ? null
      : input.discountPct.toFixed(3),
    (input.interestRatePct ?? 0).toFixed(4),
    input.interestEnabled ?? false,
    input.interestGraceDays ?? 0,
    input.statementCycle ?? 'monthly',
    input.statementAnchorDay ?? 0,
    // Only a 7- or 14-day cycle anchors to a DATE. Storing one against a monthly
    // account would be a value nothing reads and everything has to explain.
    input.statementCycle && input.statementCycle !== 'monthly'
      ? (input.statementAnchorDate ?? null)
      : null,
    input.notes?.trim() || null,
  ]
}

/** MUST stay in the same order as writableColumns above. */
const COLUMN_LIST = `code, name, status, status_reason, account_type, contact_name, email, phone,
                     address_line1, address_line2, city, postal_code, vat_number, loyalty_number,
                     group_id, rep_id, rep_name, category, payment_terms_days, credit_limit,
                     daily_limit, monthly_limit, auto_email_invoices,
                     price_structure_id, discount_pct,
                     interest_rate_pct, interest_enabled, interest_grace_days,
                     statement_cycle, statement_anchor_day, statement_anchor_date, notes`

export async function createCustomer(
  siteId: number,
  actor: Actor,
  input: CustomerInput,
): Promise<SaveResult> {
  // BEFORE validate, which rejects a blank code — see masterCodes.ts. Every
  // creation path lands here, so the till's quick-add gets a code too.
  const withCode = { ...input, code: await resolveMasterCode(siteId, 'customer', input.code) }

  const invalid = validateCustomer(withCode)
  if (invalid) return { ok: false, error: invalid }

  const code = withCode.code.trim()
  const clash = await customerQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customers WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  const result = await customerTransaction(siteId, async (tx) => {
    const placeholders = COLUMN_LIST.split(',').length
    const [res] = await tx.execute(
      `INSERT INTO customers (${COLUMN_LIST})
       VALUES (${Array.from({ length: placeholders }, () => '?').join(',')})`,
      writableColumns(withCode, await repNameFor(siteId, withCode.repId ?? null)) as never,
    )
    const id = (res as { insertId: number }).insertId

    return { ok: true as const, id }
  })

  // Post-commit tail: the row exists, tell whoever subscribed. Never throws.
  if (result.ok) {
    // The audit line goes to THIS store, not the customer's owner — see the
    // header. Outside the transaction because it is a different database when
    // the file is shared; logActivity swallows its own errors, so a failed
    // note can never undo a saved customer.
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: result.id,
      action: 'create',
      detail: `${code} — ${input.name.trim()}`,
    })

    const { enqueueEvent } = await import('./webhooks')
    await enqueueEvent(siteId, 'customer.created', {
      customerId: result.id,
      code,
      name: input.name.trim(),
    })
  }
  return result
}

export async function updateCustomer(
  siteId: number,
  actor: Actor,
  id: number,
  input: CustomerInput,
): Promise<SaveResult> {
  const invalid = validateCustomer(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getCustomer(siteId, id)
  if (!existing) return { ok: false, error: 'Customer not found.' }

  const code = input.code.trim()
  const clash = await customerQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customers WHERE code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  const saved = await customerTransaction(siteId, async (tx) => {
    // balance is absent from this list on purpose: it moves only through
    // posted transactions. Adding it here would let a form edit falsify what
    // the customer owes.
    /*
     * The SET list is derived from COLUMN_LIST rather than written out again.
     *
     * It used to be a hand-kept copy, and that is exactly how this broke: adding the
     * statement-cycle columns to COLUMN_LIST and `writableColumns` left this UPDATE
     * with three fewer placeholders than values, which MySQL reports as "Malformed
     * communication packet" — an error that says nothing about the real cause and sent
     * me looking at the driver.
     *
     * Derived, the two cannot disagree. `balance` is still absent for the reason below,
     * because it is absent from COLUMN_LIST too.
     */
    await tx.execute(
      `UPDATE customers SET
         ${COLUMN_LIST.split(',')
           .map((column) => `${column.trim()} = ?`)
           .join(', ')}
       WHERE id = ?`,
      [...writableColumns(input, await repNameFor(siteId, input.repId ?? null)), id] as never,
    )

    return { ok: true as const, id }
  })

  // Audited to THIS store rather than the customer's owner — see the header.
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: id,
    action: existing.status !== (input.status ?? 'active') ? 'status' : 'update',
    detail:
      existing.status !== (input.status ?? 'active')
        ? `${existing.status} → ${input.status ?? 'active'}${
            input.statusReason?.trim() ? ` — ${input.statusReason.trim()}` : ''
          }`
        : `${code} — ${input.name.trim()}`,
  })

  return saved
}

/**
 * Deletes a customer, but only when nothing depends on it.
 *
 * A settled account is safe to remove. One that still owes money is not: the
 * debt would vanish from the age analysis rather than being written off, and
 * nobody would notice. Once sale documents exist this must also refuse when
 * any are linked, and close the account instead.
 */
export async function deleteCustomer(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<DeleteResult> {
  const customer = await getCustomer(siteId, id)
  if (!customer) return { ok: false, error: 'Customer not found.' }

  if (customer.balance !== 0) {
    return {
      ok: false,
      error: `${customer.name} still has an outstanding balance. Settle the account first, or close it instead of deleting it.`,
    }
  }

  /* ── The guard the database used to provide ──────────────────────────────
   *
   * Until 197_shared_customer_file.sql, sales_documents, laybys and job_cards
   * held a RESTRICT foreign key to customers, so the database itself refused
   * to delete an account with history. Those keys had to go: the tables stay
   * in the branch while a shared customer lives in the group's primary, and a
   * foreign key cannot name a table in another database that the same schema
   * must also work without.
   *
   * Losing the constraint does not mean losing the rule. It runs here instead,
   * and it runs BEFORE the delete rather than as a failure during it — which
   * is a better error either way: "3 invoices" tells someone what to do, and
   * ER_ROW_IS_REFERENCED_2 does not.
   *
   * Counted in the CALLER's database on purpose. These are this branch's
   * documents; another branch's history is its own business and must not stop
   * a store tidying its list. Deleting a shared customer is refused by
   * whichever store still has documents for them.
   */
  const history = await siteQueryOne<RowDataPacket & Record<string, number>>(
    siteId,
    `SELECT
       (SELECT COUNT(*) FROM sales_documents WHERE customer_id = ?) AS documents,
       (SELECT COUNT(*) FROM laybys          WHERE customer_id = ?) AS laybys,
       (SELECT COUNT(*) FROM job_cards       WHERE customer_id = ?) AS jobs`,
    [id, id, id],
  )
  const held: string[] = []
  if (Number(history?.documents ?? 0) > 0) held.push(`${history?.documents} document(s)`)
  if (Number(history?.laybys ?? 0) > 0) held.push(`${history?.laybys} lay-by(s)`)
  if (Number(history?.jobs ?? 0) > 0) held.push(`${history?.jobs} job card(s)`)
  if (held.length > 0) {
    return {
      ok: false,
      error:
        `${customer.name} has ${held.join(', ')} at this store. ` +
        'Close the account instead of deleting it, so the history stays readable.',
    }
  }

  // Contacts go with the account through ON DELETE CASCADE, but documents and
  // comments hang off the loose (entity, entity_id) pair that has no foreign
  // key — so nothing removes them unless this does. See the header of
  // 028_party_contacts_documents_comments.sql.
  //
  // party_documents and party_comments are keyed by (entity, entity_id) and
  // serve BOTH customers and suppliers, so they cannot simply follow one of
  // them. They live in the owner's database alongside customers, which is
  // right while customers are shared and suppliers are not; sharing suppliers
  // as well will need the two entities separated. Recorded in
  // docs/shared-customer-file-origin-site.md.
  const orphaned = await customerTransaction(siteId, async (tx) => {
    const storedNames = await removeDocumentsFor(tx, 'customer', id)
    await removeCommentsFor(tx, 'customer', id)

    await tx.execute('DELETE FROM customers WHERE id = ?', [id] as never)
    return storedNames
  })

  // Audited to THIS store rather than the customer's owner — see the header.
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: id,
    action: 'delete',
    detail: `${customer.code} — ${customer.name}`,
  })

  // Only once the rows are actually committed. Unlinking inside the transaction
  // would destroy the files even if it then rolled back, and a rollback that
  // has already deleted the paperwork is not a rollback.
  await Promise.all(orphaned.map(deleteStoredFile))

  return { ok: true }
}

/* ── Bulk operations ─────────────────────────────────────────────────────── */

/**
 * What a bulk action did, and what it refused to do.
 *
 * Reporting the refusals by name is the whole point: "38 updated, 2 skipped"
 * with no list of which two, and why, is worse than not offering the action —
 * the user cannot tell whether the two that matter went through.
 */
export type BulkResult = {
  updated: number
  skipped: { id: number; code: string; name: string; reason: string }[]
}

export type BulkChange =
  | { kind: 'status'; status: CustomerStatus; reason?: string | null }
  | { kind: 'terms'; paymentTermsDays: number }
  | { kind: 'creditLimit'; creditLimit: number }
  | { kind: 'group'; groupId: number | null }
  | { kind: 'rep'; repId: number | null }
  | { kind: 'category'; category: string | null }

/**
 * Applies one change to many accounts.
 *
 * Validates every row FIRST, then updates the permitted set in a single
 * statement. Per-row updates would leave a half-applied change behind on the
 * first failure, and a single blind UPDATE ... WHERE id IN (...) would apply
 * to rows that should have been refused.
 */
export async function bulkUpdateCustomers(
  siteId: number,
  actor: Actor,
  ids: readonly number[],
  change: BulkChange,
): Promise<BulkResult> {
  const unique = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0)
  if (unique.length === 0) return { updated: 0, skipped: [] }

  const invalid = validateBulkChange(change)
  if (invalid) {
    return {
      updated: 0,
      skipped: unique.map((id) => ({ id, code: '', name: '', reason: invalid })),
    }
  }

  const rows = await customerQuery<Row>(
    siteId,
    `${SELECT_CUSTOMER} WHERE c.id IN (${unique.map(() => '?').join(',')})`,
    unique,
  )
  const customers = rows.map(mapCustomer)

  const permitted: Customer[] = []
  const skipped: BulkResult['skipped'] = []

  for (const customer of customers) {
    const refusal = refuseBulk(customer, change)
    if (refusal) skipped.push({ id: customer.id, code: customer.code, name: customer.name, reason: refusal })
    else permitted.push(customer)
  }

  // An id that matched no row was deleted between the list render and the
  // action — report it rather than silently counting it as done.
  for (const id of unique) {
    if (!customers.some((c) => c.id === id)) {
      skipped.push({ id, code: '', name: '', reason: 'No longer exists.' })
    }
  }

  if (permitted.length === 0) return { updated: 0, skipped }

  // Resolved here rather than in bulkSetClause, which is sync: a rep id is this
  // store's, and writing it into a shared file without the name would reassign
  // every selected account to whoever holds that id at the owner.
  const { sql, params } = bulkSetClause(
    change,
    change.kind === 'rep' ? await repNameFor(siteId, change.repId ?? null) : null,
  )
  const idList = permitted.map((c) => c.id)

  await customerTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE customers SET ${sql} WHERE id IN (${idList.map(() => '?').join(',')})`,
      [...params, ...idList] as never,
    )
  })

  // One audit row per account, not one for the batch: the Activity tab of a
  // single customer must show what happened to IT. Written to THIS store,
  // after the commit — see the header.
  for (const customer of permitted) {
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: customer.id,
      action: change.kind === 'status' ? 'status' : 'bulk',
      detail: describeBulk(change, customer),
    })
  }

  return { updated: permitted.length, skipped }
}

function validateBulkChange(change: BulkChange): string | null {
  if (change.kind === 'terms') {
    if (change.paymentTermsDays < 0 || change.paymentTermsDays > 365) {
      return 'Payment terms must be between 0 and 365 days.'
    }
  }
  if (change.kind === 'creditLimit' && change.creditLimit < 0) {
    return 'Credit limit cannot be negative.'
  }
  if (change.kind === 'status' && change.status !== 'active' && !change.reason?.trim()) {
    return 'Give a reason when setting accounts to a non-active status.'
  }
  return null
}

/** Why this account cannot take this change. Null means it can. */
function refuseBulk(customer: Customer, change: BulkChange): string | null {
  if (change.kind === 'status' && change.status === 'closed' && customer.balance !== 0) {
    // The same rule as deleteCustomer, for the same reason: closing hides the
    // account from the default age analysis, and a debt must not disappear.
    return 'Still has an outstanding balance.'
  }
  return null
}

function bulkSetClause(
  change: BulkChange,
  repName: string | null,
): { sql: string; params: unknown[] } {
  switch (change.kind) {
    case 'status':
      return {
        sql: 'status = ?, status_reason = ?',
        params: [change.status, change.status === 'active' ? null : (change.reason?.trim() ?? null)],
      }
    case 'terms':
      return { sql: 'payment_terms_days = ?', params: [change.paymentTermsDays] }
    case 'creditLimit':
      return { sql: 'credit_limit = ?', params: [change.creditLimit.toFixed(4)] }
    case 'group':
      return { sql: 'group_id = ?', params: [change.groupId] }
    case 'rep':
      // Both, and the name is what survives the boundary. Clearing the rep
      // clears both, so the two can never disagree about who reps an account.
      return { sql: 'rep_id = ?, rep_name = ?', params: [change.repId, repName] }
    case 'category':
      return { sql: 'category = ?', params: [change.category?.trim() || null] }
  }
}

function describeBulk(change: BulkChange, customer: Customer): string {
  switch (change.kind) {
    case 'status':
      return `${customer.status} → ${change.status}${
        change.reason?.trim() ? ` — ${change.reason.trim()}` : ''
      }`
    case 'terms':
      return `Payment terms set to ${change.paymentTermsDays} days`
    case 'creditLimit':
      return `Credit limit set to ${change.creditLimit.toFixed(2)}`
    case 'group':
      return change.groupId ? 'Group reassigned' : 'Group cleared'
    case 'rep':
      return change.repId ? 'Rep reassigned' : 'Rep cleared'
    case 'category':
      return change.category?.trim() ? `Category set to ${change.category.trim()}` : 'Category cleared'
  }
}

/** Every id matching a filter, for "select all N matching" on the list screen. */
export async function customerIdsMatching(
  siteId: number,
  opts: CustomerListOptions,
): Promise<number[]> {
  const { sql: whereSql, params } = buildWhere(await withRepName(siteId, opts))
  const rows = await customerQuery<RowDataPacket & { id: number }>(
    siteId,
    `SELECT c.id FROM customers c ${whereSql} LIMIT 5000`,
    params,
  )
  return rows.map((r) => Number(r.id))
}

/** Narrows an untrusted string to a status, for reading URL params and form fields. */
export function toCustomerStatus(value: unknown): CustomerStatus | null {
  const raw = String(value ?? '')
  return (CUSTOMER_STATUSES as readonly string[]).includes(raw) ? (raw as CustomerStatus) : null
}

/**
 * Every tradeable customer as a pickable option — id and a label that
 * identifies one uniquely.
 *
 * ── WHY NOT listCustomers ──────────────────────────────────────────────────
 *
 * That one is paged and capped, which is right for a screen and wrong for a
 * picker: a site over the cap would silently be unable to name some of its
 * customers, with nothing on screen saying so. The same reasoning as
 * supplierOptions in 162 — and the same live evidence, since this site has more
 * suppliers than the cap allows.
 *
 * `on_hold` is included alongside `active` on purpose. A customer whose account
 * is on hold still has an agreement and still logs jobs; excluding them would
 * silently drop the promise for exactly the accounts somebody is arguing with.
 */
export async function customerOptions(
  siteId: number,
): Promise<{ id: number; name: string }[]> {
  const rows = await customerQuery<RowDataPacket & { id: number; code: string; name: string }>(
    siteId,
    `SELECT id, code, name FROM customers
      WHERE status IN ('active','on_hold')
      ORDER BY name, code`,
  )
  return rows.map((r) => ({ id: Number(r.id), name: `${String(r.name)} (${String(r.code)})` }))
}

import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import {
  toAccountType,
  allowsCredit,
  DEFAULT_ACCOUNT_TYPE,
  type AccountType,
} from '../accountTypes'
import { isEmail } from './customerLookups'
import { resolveMasterCode } from './masterCodes'
import { logActivityTx, type Actor } from './activityLog'
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
  balance: number
  /** Annual nominal rate. Zero means the group's default applies, if it has one. */
  interestRatePct: number
  /** Explicit opt-in, separate from the rate — see interestRules.ts on the NCA. */
  interestEnabled: boolean
  interestGraceDays: number
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
    balance,
    interestRatePct: toNum(r.interest_rate_pct),
    interestEnabled: Boolean(r.interest_enabled),
    interestGraceDays: Number(r.interest_grace_days ?? 0),
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    overLimit,
    availableCredit: Math.max(creditLimit - balance, 0),
    canBuyOnAccount:
      TRADING_STATUSES.includes(status) && allowsCredit(accountType) && creditLimit > 0 && !overLimit,
  }
}

const SELECT_CUSTOMER = `
  SELECT c.id, c.code, c.name, c.status, c.status_reason, c.account_type,
         c.contact_name, c.email, c.phone, c.address_line1, c.address_line2,
         c.city, c.postal_code, c.vat_number, c.loyalty_number,
         c.group_id, c.rep_id, c.category, c.payment_terms_days,
         c.credit_limit, c.balance,
         c.interest_rate_pct, c.interest_enabled, c.interest_grace_days,
         c.notes, c.created_at, c.updated_at,
         g.name AS group_name,
         r.name AS rep_name
    FROM customers c
    LEFT JOIN customer_groups g ON g.id = c.group_id
    LEFT JOIN sales_reps     r ON r.id = c.rep_id
`

export type CustomerSort = 'name' | 'code' | 'balance' | 'created'

export type CustomerListOptions = {
  search?: string
  /** Empty or omitted means every status EXCEPT closed — see the note below. */
  statuses?: readonly CustomerStatus[]
  groupId?: number
  repId?: number
  category?: string
  /** Only accounts with a non-zero balance. */
  withBalanceOnly?: boolean
  /** Only accounts past their credit limit. */
  overLimitOnly?: boolean
  sort?: CustomerSort
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
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
  if (opts.repId) {
    where.push('c.rep_id = ?')
    params.push(opts.repId)
  }
  if (opts.category?.trim()) {
    where.push('c.category = ?')
    params.push(opts.category.trim())
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
  const { sql: whereSql, params } = buildWhere(opts)

  // Clamped, then interpolated: mysql2 rejects LIMIT/OFFSET as placeholders.
  // Safe only because both are numbers that have been through Math.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const column = SORT_COLUMNS[opts.sort ?? 'name']
  const direction = opts.direction === 'desc' ? 'DESC' : 'ASC'

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_CUSTOMER} ${whereSql}
        ORDER BY ${column} ${direction}, c.id ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
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
  const row = await siteQueryOne<Row>(
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
  const row = await siteQueryOne<Row>(siteId, `${SELECT_CUSTOMER} WHERE c.id = ? LIMIT 1`, [id])
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
  /** Annual nominal rate. Zero means fall back to the group's default. */
  interestRatePct?: number
  /** Explicit opt-in — see the NCA note in interestRules.ts. */
  interestEnabled?: boolean
  interestGraceDays?: number
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

/** Columns written by both create and update, in one place so they cannot drift. */
function writableColumns(input: CustomerInput): unknown[] {
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
    input.category?.trim() || null,
    input.paymentTermsDays ?? 30,
    (input.creditLimit ?? 0).toFixed(4),
    (input.interestRatePct ?? 0).toFixed(4),
    input.interestEnabled ?? false,
    input.interestGraceDays ?? 0,
    input.notes?.trim() || null,
  ]
}

/** MUST stay in the same order as writableColumns above. */
const COLUMN_LIST = `code, name, status, status_reason, account_type, contact_name, email, phone,
                     address_line1, address_line2, city, postal_code, vat_number, loyalty_number,
                     group_id, rep_id, category, payment_terms_days, credit_limit,
                     interest_rate_pct, interest_enabled, interest_grace_days, notes`

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
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customers WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  return siteTransaction(siteId, async (tx) => {
    const placeholders = COLUMN_LIST.split(',').length
    const [res] = await tx.execute(
      `INSERT INTO customers (${COLUMN_LIST})
       VALUES (${Array.from({ length: placeholders }, () => '?').join(',')})`,
      writableColumns(withCode) as never,
    )
    const id = (res as { insertId: number }).insertId

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: id,
      action: 'create',
      detail: `${code} — ${input.name.trim()}`,
    })

    return { ok: true as const, id }
  })
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
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM customers WHERE code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  return siteTransaction(siteId, async (tx) => {
    // balance is absent from this list on purpose: it moves only through
    // posted transactions. Adding it here would let a form edit falsify what
    // the customer owes.
    await tx.execute(
      `UPDATE customers SET
         code = ?, name = ?, status = ?, status_reason = ?, account_type = ?,
         contact_name = ?, email = ?, phone = ?, address_line1 = ?, address_line2 = ?,
         city = ?, postal_code = ?, vat_number = ?, loyalty_number = ?,
         group_id = ?, rep_id = ?, category = ?, payment_terms_days = ?,
         credit_limit = ?,
         interest_rate_pct = ?, interest_enabled = ?, interest_grace_days = ?,
         notes = ?
       WHERE id = ?`,
      [...writableColumns(input), id] as never,
    )

    await logActivityTx(tx, actor, {
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

    return { ok: true as const, id }
  })
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

  // Contacts go with the account through ON DELETE CASCADE, but documents and
  // comments hang off the loose (entity, entity_id) pair that has no foreign
  // key — so nothing removes them unless this does. See the header of
  // 028_party_contacts_documents_comments.sql.
  const orphaned = await siteTransaction(siteId, async (tx) => {
    const storedNames = await removeDocumentsFor(tx, 'customer', id)
    await removeCommentsFor(tx, 'customer', id)

    await tx.execute('DELETE FROM customers WHERE id = ?', [id] as never)
    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: id,
      action: 'delete',
      detail: `${customer.code} — ${customer.name}`,
    })
    return storedNames
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

  const rows = await siteQuery<Row>(
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

  const { sql, params } = bulkSetClause(change)
  const idList = permitted.map((c) => c.id)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE customers SET ${sql} WHERE id IN (${idList.map(() => '?').join(',')})`,
      [...params, ...idList] as never,
    )

    // One audit row per account, not one for the batch: the Activity tab of a
    // single customer must show what happened to IT.
    for (const customer of permitted) {
      await logActivityTx(tx, actor, {
        entity: 'customer',
        entityId: customer.id,
        action: change.kind === 'status' ? 'status' : 'bulk',
        detail: describeBulk(change, customer),
      })
    }
  })

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

function bulkSetClause(change: BulkChange): { sql: string; params: unknown[] } {
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
      return { sql: 'rep_id = ?', params: [change.repId] }
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
  const { sql: whereSql, params } = buildWhere(opts)
  const rows = await siteQuery<RowDataPacket & { id: number }>(
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

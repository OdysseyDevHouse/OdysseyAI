import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { isEmail } from './customerLookups'
import { logActivityTx, type Actor } from './activityLog'
import { removeDocumentsFor } from './partyDocuments'
import { removeCommentsFor } from './partyComments'
import { deleteStoredFile } from '../uploads'

/**
 * Suppliers — the creditors book.
 *
 * The mirror of customers, with the sign convention flipped: a positive
 * `balance` here means WE owe THEM. Like a customer's, it moves only through
 * posted transactions and is absent from every UPDATE below.
 *
 * Written as its own module rather than a generic parameterised one: the
 * validation, the columns and the refusal rules genuinely differ, and sharing
 * them would mean threading a table name through a query builder, which is how
 * an injection bug gets in.
 */

export const SUPPLIER_STATUSES = ['active', 'on_hold', 'inactive', 'closed'] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]

export type Supplier = {
  id: number
  code: string
  name: string
  status: SupplierStatus
  statusReason: string | null
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  vatNumber: string | null
  accountNumber: string | null
  paymentTermsDays: number
  /**
   * Settlement discount: pay within this many days of the invoice to earn
   * `settlementDiscountPct`. Both must be non-zero for a discount to exist.
   * '2/10 net 30' is days=10, pct=2, paymentTermsDays=30.
   */
  settlementDiscountDays: number
  settlementDiscountPct: number
  leadTimeDays: number
  minimumOrder: number
  bankName: string | null
  bankBranch: string | null
  bankAccount: string | null
  category: string | null
  balance: number
  notes: string | null
  createdAt: Date
  updatedAt: Date
  /** Products currently linked to this supplier. */
  productCount: number
  /** Whether new orders may be raised against them. */
  canOrder: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapSupplier(r: Row): Supplier {
  const status = String(r.status) as SupplierStatus
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    status,
    statusReason: (r.status_reason as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    addressLine1: (r.address_line1 as string | null) ?? null,
    addressLine2: (r.address_line2 as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    postalCode: (r.postal_code as string | null) ?? null,
    vatNumber: (r.vat_number as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    paymentTermsDays: Number(r.payment_terms_days),
    settlementDiscountDays: Number(r.settlement_discount_days ?? 0),
    settlementDiscountPct: toNum(r.settlement_discount_pct),
    leadTimeDays: Number(r.lead_time_days),
    minimumOrder: toNum(r.minimum_order),
    bankName: (r.bank_name as string | null) ?? null,
    bankBranch: (r.bank_branch as string | null) ?? null,
    bankAccount: (r.bank_account as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    balance: toNum(r.balance),
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    productCount: Number(r.product_count ?? 0),
    canOrder: status === 'active',
  }
}

const SELECT_SUPPLIER = `
  SELECT s.id, s.code, s.name, s.status, s.status_reason, s.contact_name, s.email, s.phone,
         s.address_line1, s.address_line2, s.city, s.postal_code, s.vat_number,
         s.account_number, s.payment_terms_days,
         s.settlement_discount_days, s.settlement_discount_pct,
         s.lead_time_days, s.minimum_order,
         s.bank_name, s.bank_branch, s.bank_account, s.category, s.balance, s.notes,
         s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id) AS product_count
    FROM suppliers s
`

export type SupplierSort = 'name' | 'code' | 'balance' | 'terms'

export type SupplierListOptions = {
  search?: string
  statuses?: readonly SupplierStatus[]
  category?: string
  withBalanceOnly?: boolean
  sort?: SupplierSort
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

function buildWhere(opts: SupplierListOptions): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.statuses?.length) {
    where.push(`s.status IN (${opts.statuses.map(() => '?').join(',')})`)
    params.push(...opts.statuses)
  } else {
    where.push("s.status <> 'closed'")
  }

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push(
      '(s.name LIKE ? OR s.code LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.contact_name LIKE ? OR s.account_number LIKE ?)',
    )
    params.push(term, term, term, term, term, term)
  }

  if (opts.category?.trim()) {
    where.push('s.category = ?')
    params.push(opts.category.trim())
  }
  if (opts.withBalanceOnly) where.push('s.balance <> 0')

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

const SORT_COLUMNS: Record<SupplierSort, string> = {
  name: 's.name',
  code: 's.code',
  balance: 's.balance',
  terms: 's.payment_terms_days',
}

export async function listSuppliers(
  siteId: number,
  opts: SupplierListOptions = {},
): Promise<{ items: Supplier[]; total: number }> {
  const { sql: whereSql, params } = buildWhere(opts)
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const column = SORT_COLUMNS[opts.sort ?? 'name']
  const direction = opts.direction === 'desc' ? 'DESC' : 'ASC'

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_SUPPLIER} ${whereSql}
        ORDER BY ${column} ${direction}, s.id ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total FROM suppliers s ${whereSql}`,
      params,
    ),
  ])

  return { items: rows.map(mapSupplier), total: Number(countRow?.total ?? 0) }
}

export type SupplierSummary = {
  total: number
  owed: number
  totalOwed: number
  onHold: number
}

export async function supplierSummary(siteId: number): Promise<SupplierSummary> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*)                                                 AS total,
            SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END)             AS owed,
            COALESCE(SUM(CASE WHEN balance > 0 THEN balance END), 0) AS total_owed,
            SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END)      AS on_hold
       FROM suppliers
      WHERE status <> 'closed'`,
  )

  return {
    total: Number(row?.total ?? 0),
    owed: Number(row?.owed ?? 0),
    totalOwed: toNum(row?.total_owed),
    onHold: Number(row?.on_hold ?? 0),
  }
}

export async function getSupplier(siteId: number, id: number): Promise<Supplier | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_SUPPLIER} WHERE s.id = ? LIMIT 1`, [id])
  return row ? mapSupplier(row) : null
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type SupplierInput = {
  code: string
  name: string
  status?: SupplierStatus
  statusReason?: string | null
  contactName?: string | null
  email?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  postalCode?: string | null
  vatNumber?: string | null
  accountNumber?: string | null
  paymentTermsDays?: number
  /** '2/10 net 30' is days=10, pct=2, paymentTermsDays=30. */
  settlementDiscountDays?: number
  settlementDiscountPct?: number
  leadTimeDays?: number
  minimumOrder?: number
  bankName?: string | null
  bankBranch?: string | null
  bankAccount?: string | null
  category?: string | null
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

export function validateSupplier(input: SupplierInput): string | null {
  if (!input.code?.trim()) return 'A supplier code is required.'
  if (input.code.trim().length > 32) return 'Supplier code must be 32 characters or fewer.'
  if (!input.name?.trim()) return 'A supplier name is required.'
  if (input.name.trim().length > 160) return 'Name must be 160 characters or fewer.'
  if (input.email?.trim() && !isEmail(input.email.trim())) {
    return 'That email address does not look valid.'
  }
  if ((input.paymentTermsDays ?? 0) < 0 || (input.paymentTermsDays ?? 0) > 365) {
    return 'Payment terms must be between 0 and 365 days.'
  }
  if ((input.settlementDiscountPct ?? 0) < 0 || (input.settlementDiscountPct ?? 0) >= 100) {
    return 'A settlement discount must be between 0 and 100 percent.'
  }
  if ((input.settlementDiscountDays ?? 0) < 0 || (input.settlementDiscountDays ?? 0) > 365) {
    return 'The discount window must be between 0 and 365 days.'
  }
  // A discount window longer than the payment terms earns a discount for paying
  // late, which no supplier means. Almost always the two were typed the wrong
  // way round — 30/10 rather than 2/10 net 30.
  if (
    (input.settlementDiscountPct ?? 0) > 0 &&
    (input.settlementDiscountDays ?? 0) > (input.paymentTermsDays ?? 30)
  ) {
    return 'The discount window is longer than the payment terms — check the two are the right way round.'
  }
  if ((input.leadTimeDays ?? 0) < 0 || (input.leadTimeDays ?? 0) > 365) {
    return 'Lead time must be between 0 and 365 days.'
  }
  if ((input.minimumOrder ?? 0) < 0) return 'Minimum order cannot be negative.'
  if (input.status && input.status !== 'active' && !input.statusReason?.trim()) {
    return 'Give a reason when a supplier is not active.'
  }
  return null
}

function writableColumns(input: SupplierInput): unknown[] {
  return [
    input.code.trim(),
    input.name.trim(),
    input.status ?? 'active',
    input.statusReason?.trim() || null,
    input.contactName?.trim() || null,
    input.email?.trim().toLowerCase() || null,
    input.phone?.trim() || null,
    input.addressLine1?.trim() || null,
    input.addressLine2?.trim() || null,
    input.city?.trim() || null,
    input.postalCode?.trim() || null,
    input.vatNumber?.trim() || null,
    input.accountNumber?.trim() || null,
    input.paymentTermsDays ?? 30,
    input.settlementDiscountDays ?? 0,
    (input.settlementDiscountPct ?? 0).toFixed(4),
    input.leadTimeDays ?? 0,
    (input.minimumOrder ?? 0).toFixed(4),
    input.bankName?.trim() || null,
    input.bankBranch?.trim() || null,
    input.bankAccount?.trim() || null,
    input.category?.trim() || null,
    input.notes?.trim() || null,
  ]
}

/** MUST stay in the same order as writableColumns above. */
const COLUMN_LIST = `code, name, status, status_reason, contact_name, email, phone,
                     address_line1, address_line2, city, postal_code, vat_number,
                     account_number, payment_terms_days,
                     settlement_discount_days, settlement_discount_pct,
                     lead_time_days, minimum_order,
                     bank_name, bank_branch, bank_account, category, notes`

export async function createSupplier(
  siteId: number,
  actor: Actor,
  input: SupplierInput,
): Promise<SaveResult> {
  const invalid = validateSupplier(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM suppliers WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `Supplier code "${code}" is already in use.` }

  return siteTransaction(siteId, async (tx) => {
    const placeholders = COLUMN_LIST.split(',').length
    const [res] = await tx.execute(
      `INSERT INTO suppliers (${COLUMN_LIST})
       VALUES (${Array.from({ length: placeholders }, () => '?').join(',')})`,
      writableColumns(input) as never,
    )
    const id = (res as { insertId: number }).insertId

    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: id,
      action: 'create',
      detail: `${code} — ${input.name.trim()}`,
    })

    return { ok: true as const, id }
  })
}

export async function updateSupplier(
  siteId: number,
  actor: Actor,
  id: number,
  input: SupplierInput,
): Promise<SaveResult> {
  const invalid = validateSupplier(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getSupplier(siteId, id)
  if (!existing) return { ok: false, error: 'Supplier not found.' }

  const code = input.code.trim()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM suppliers WHERE code = ? AND id <> ? LIMIT 1',
    [code, id],
  )
  if (clash) return { ok: false, error: `Supplier code "${code}" is already in use.` }

  const nextStatus = input.status ?? 'active'

  return siteTransaction(siteId, async (tx) => {
    // balance is deliberately absent — see the module comment.
    await tx.execute(
      `UPDATE suppliers SET
         code = ?, name = ?, status = ?, status_reason = ?, contact_name = ?, email = ?,
         phone = ?, address_line1 = ?, address_line2 = ?, city = ?, postal_code = ?,
         vat_number = ?, account_number = ?, payment_terms_days = ?,
         settlement_discount_days = ?, settlement_discount_pct = ?,
         lead_time_days = ?,
         minimum_order = ?, bank_name = ?, bank_branch = ?, bank_account = ?,
         category = ?, notes = ?
       WHERE id = ?`,
      [...writableColumns(input), id] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: id,
      action: existing.status !== nextStatus ? 'status' : 'update',
      detail:
        existing.status !== nextStatus
          ? `${existing.status} → ${nextStatus}${
              input.statusReason?.trim() ? ` — ${input.statusReason.trim()}` : ''
            }`
          : `${code} — ${input.name.trim()}`,
    })

    return { ok: true as const, id }
  })
}

/**
 * Deletes a supplier only when nothing depends on it.
 *
 * Two guards, for different reasons. An outstanding balance means we still owe
 * them, and deleting the account would hide a payable rather than settle it.
 * Linked products would lose their supply route silently — the FK is CASCADE
 * on product_suppliers, so the links really would vanish.
 */
export async function deleteSupplier(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<DeleteResult> {
  const supplier = await getSupplier(siteId, id)
  if (!supplier) return { ok: false, error: 'Supplier not found.' }

  if (supplier.balance !== 0) {
    return {
      ok: false,
      error: `${supplier.name} still has an outstanding balance. Settle the account first, or close it instead of deleting it.`,
    }
  }
  if (supplier.productCount > 0) {
    return {
      ok: false,
      error: `${supplier.productCount} product${
        supplier.productCount === 1 ? ' is' : 's are'
      } linked to ${supplier.name}. Unlink ${
        supplier.productCount === 1 ? 'it' : 'them'
      } first, or deactivate this supplier instead.`,
    }
  }

  // Contacts cascade with the account; documents and comments do not, because
  // they hang off the loose (entity, entity_id) pair. Same reasoning as
  // deleteCustomer — see 028_party_contacts_documents_comments.sql.
  const orphaned = await siteTransaction(siteId, async (tx) => {
    const storedNames = await removeDocumentsFor(tx, 'supplier', id)
    await removeCommentsFor(tx, 'supplier', id)

    await tx.execute('DELETE FROM suppliers WHERE id = ?', [id] as never)
    await logActivityTx(tx, actor, {
      entity: 'supplier',
      entityId: id,
      action: 'delete',
      detail: `${supplier.code} — ${supplier.name}`,
    })
    return storedNames
  })

  // After the commit, never inside it — see deleteCustomer.
  await Promise.all(orphaned.map(deleteStoredFile))

  return { ok: true }
}

/* ── Bulk operations ─────────────────────────────────────────────────────── */

export type SupplierBulkResult = {
  updated: number
  skipped: { id: number; code: string; name: string; reason: string }[]
}

export type SupplierBulkChange =
  | { kind: 'status'; status: SupplierStatus; reason?: string | null }
  | { kind: 'terms'; paymentTermsDays: number }
  | { kind: 'category'; category: string | null }

export async function bulkUpdateSuppliers(
  siteId: number,
  actor: Actor,
  ids: readonly number[],
  change: SupplierBulkChange,
): Promise<SupplierBulkResult> {
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
    `${SELECT_SUPPLIER} WHERE s.id IN (${unique.map(() => '?').join(',')})`,
    unique,
  )
  const suppliers = rows.map(mapSupplier)

  const permitted: Supplier[] = []
  const skipped: SupplierBulkResult['skipped'] = []

  for (const supplier of suppliers) {
    if (change.kind === 'status' && change.status === 'closed' && supplier.balance !== 0) {
      skipped.push({
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        reason: 'Still has an outstanding balance.',
      })
      continue
    }
    permitted.push(supplier)
  }

  for (const id of unique) {
    if (!suppliers.some((s) => s.id === id)) {
      skipped.push({ id, code: '', name: '', reason: 'No longer exists.' })
    }
  }

  if (permitted.length === 0) return { updated: 0, skipped }

  const { sql, params } = bulkSetClause(change)
  const idList = permitted.map((s) => s.id)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE suppliers SET ${sql} WHERE id IN (${idList.map(() => '?').join(',')})`,
      [...params, ...idList] as never,
    )
    for (const supplier of permitted) {
      await logActivityTx(tx, actor, {
        entity: 'supplier',
        entityId: supplier.id,
        action: change.kind === 'status' ? 'status' : 'bulk',
        detail: describeBulk(change, supplier),
      })
    }
  })

  return { updated: permitted.length, skipped }
}

function validateBulkChange(change: SupplierBulkChange): string | null {
  if (change.kind === 'terms' && (change.paymentTermsDays < 0 || change.paymentTermsDays > 365)) {
    return 'Payment terms must be between 0 and 365 days.'
  }
  if (change.kind === 'status' && change.status !== 'active' && !change.reason?.trim()) {
    return 'Give a reason when setting suppliers to a non-active status.'
  }
  return null
}

function bulkSetClause(change: SupplierBulkChange): { sql: string; params: unknown[] } {
  switch (change.kind) {
    case 'status':
      return {
        sql: 'status = ?, status_reason = ?',
        params: [change.status, change.status === 'active' ? null : (change.reason?.trim() ?? null)],
      }
    case 'terms':
      return { sql: 'payment_terms_days = ?', params: [change.paymentTermsDays] }
    case 'category':
      return { sql: 'category = ?', params: [change.category?.trim() || null] }
  }
}

function describeBulk(change: SupplierBulkChange, supplier: Supplier): string {
  switch (change.kind) {
    case 'status':
      return `${supplier.status} → ${change.status}${
        change.reason?.trim() ? ` — ${change.reason.trim()}` : ''
      }`
    case 'terms':
      return `Payment terms set to ${change.paymentTermsDays} days`
    case 'category':
      return change.category?.trim() ? `Category set to ${change.category.trim()}` : 'Category cleared'
  }
}

export async function supplierIdsMatching(
  siteId: number,
  opts: SupplierListOptions,
): Promise<number[]> {
  const { sql: whereSql, params } = buildWhere(opts)
  const rows = await siteQuery<RowDataPacket & { id: number }>(
    siteId,
    `SELECT s.id FROM suppliers s ${whereSql} LIMIT 5000`,
    params,
  )
  return rows.map((r) => Number(r.id))
}

export function toSupplierStatus(value: unknown): SupplierStatus | null {
  const raw = String(value ?? '')
  return (SUPPLIER_STATUSES as readonly string[]).includes(raw) ? (raw as SupplierStatus) : null
}

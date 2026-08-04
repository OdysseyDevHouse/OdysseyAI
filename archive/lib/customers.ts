import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { toNum } from './decimals'

export type CustomerRow = RowDataPacket & {
  id: number
  code: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postal_code: string | null
  vat_number: string | null
  loyalty_number: string | null
  credit_limit: string
  balance: string
  on_hold: number
  is_active: number
  notes: string | null
}

export type Customer = {
  id: number
  code: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  vatNumber: string | null
  loyaltyNumber: string | null
  creditLimit: number
  balance: number
  onHold: boolean
  isActive: boolean
  notes: string | null
  /** True when the account is over its limit — the POS should refuse credit. */
  overLimit: boolean
  availableCredit: number
}

function mapCustomer(r: CustomerRow): Customer {
  const creditLimit = toNum(r.credit_limit)
  const balance = toNum(r.balance)
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    postalCode: r.postal_code,
    vatNumber: r.vat_number,
    loyaltyNumber: r.loyalty_number,
    creditLimit,
    balance,
    onHold: !!r.on_hold,
    isActive: !!r.is_active,
    notes: r.notes,
    // A zero limit means "no credit granted", not "unlimited".
    overLimit: balance > creditLimit,
    availableCredit: Math.max(creditLimit - balance, 0),
  }
}

const COLUMNS = `id, code, name, contact_name, email, phone, address_line1, address_line2,
                 city, postal_code, vat_number, loyalty_number, credit_limit, balance,
                 on_hold, is_active, notes`

export type CustomerListOptions = {
  search?: string
  includeInactive?: boolean
  onHoldOnly?: boolean
  withBalanceOnly?: boolean
  limit?: number
  offset?: number
}

export async function listCustomers(
  storeId: number,
  opts: CustomerListOptions = {},
): Promise<{ items: Customer[]; total: number }> {
  const where: string[] = ['store_id = ?']
  const params: unknown[] = [storeId]

  if (!opts.includeInactive) where.push('is_active = 1')
  if (opts.onHoldOnly) where.push('on_hold = 1')
  if (opts.withBalanceOnly) where.push('balance <> 0')

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(name LIKE ? OR code LIKE ? OR email LIKE ? OR phone LIKE ? OR loyalty_number = ?)')
    params.push(term, term, term, term, opts.search.trim())
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const rows = await query<CustomerRow>(
    `SELECT ${COLUMNS} FROM customers ${whereSql} ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM customers ${whereSql}`,
    params,
  )

  return { items: rows.map(mapCustomer), total: countRow?.total ?? 0 }
}

export async function getCustomer(storeId: number, id: number): Promise<Customer | null> {
  const row = await queryOne<CustomerRow>(
    `SELECT ${COLUMNS} FROM customers WHERE store_id = ? AND id = ? LIMIT 1`,
    [storeId, id],
  )
  return row ? mapCustomer(row) : null
}

export type CustomerInput = {
  code: string
  name: string
  contactName?: string | null
  email?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  postalCode?: string | null
  vatNumber?: string | null
  loyaltyNumber?: string | null
  creditLimit?: number
  onHold?: boolean
  isActive?: boolean
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateCustomer(input: CustomerInput): string | null {
  if (!input.code?.trim()) return 'A customer code is required.'
  if (!input.name?.trim()) return 'A customer name is required.'
  if (input.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    return 'That email address does not look valid.'
  }
  if ((input.creditLimit ?? 0) < 0) return 'Credit limit cannot be negative.'
  return null
}

function inputParams(input: CustomerInput): unknown[] {
  return [
    input.code.trim(),
    input.name.trim(),
    input.contactName?.trim() || null,
    input.email?.trim().toLowerCase() || null,
    input.phone?.trim() || null,
    input.addressLine1?.trim() || null,
    input.addressLine2?.trim() || null,
    input.city?.trim() || null,
    input.postalCode?.trim() || null,
    input.vatNumber?.trim() || null,
    input.loyaltyNumber?.trim() || null,
    (input.creditLimit ?? 0).toFixed(4),
    input.onHold ? 1 : 0,
    input.isActive === false ? 0 : 1,
    input.notes?.trim() || null,
  ]
}

export async function createCustomer(
  storeId: number,
  userId: number,
  input: CustomerInput,
): Promise<SaveResult> {
  const invalid = validateCustomer(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM customers WHERE store_id = ? AND code = ? LIMIT 1',
    [storeId, code],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  const res = await execute(
    `INSERT INTO customers
       (store_id, code, name, contact_name, email, phone, address_line1, address_line2,
        city, postal_code, vat_number, loyalty_number, credit_limit, on_hold, is_active, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [storeId, ...inputParams(input)],
  )

  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'customer',?, 'create', ?)`,
    [storeId, userId, res.insertId, `${code} — ${input.name.trim()}`],
  )

  return { ok: true, id: res.insertId }
}

export async function updateCustomer(
  storeId: number,
  userId: number,
  id: number,
  input: CustomerInput,
): Promise<SaveResult> {
  const invalid = validateCustomer(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM customers WHERE store_id = ? AND code = ? AND id <> ? LIMIT 1',
    [storeId, code, id],
  )
  if (clash) return { ok: false, error: `Customer code "${code}" is already in use.` }

  const res = await execute(
    `UPDATE customers SET
       code = ?, name = ?, contact_name = ?, email = ?, phone = ?, address_line1 = ?,
       address_line2 = ?, city = ?, postal_code = ?, vat_number = ?, loyalty_number = ?,
       credit_limit = ?, on_hold = ?, is_active = ?, notes = ?
     WHERE store_id = ? AND id = ?`,
    [...inputParams(input), storeId, id],
  )
  if (res.affectedRows === 0) return { ok: false, error: 'Customer not found.' }
  // balance is never set here — it moves only through posted transactions.

  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'customer',?, 'update', ?)`,
    [storeId, userId, id, `${code} — ${input.name.trim()}`],
  )

  return { ok: true, id }
}

export async function deactivateCustomer(
  storeId: number,
  userId: number,
  id: number,
): Promise<{ ok: boolean; error?: string }> {
  const customer = await getCustomer(storeId, id)
  if (!customer) return { ok: false, error: 'Customer not found.' }
  // Deactivating an account that still owes money would hide the debt from the
  // default (active-only) age analysis.
  if (customer.balance !== 0) {
    return { ok: false, error: 'This customer still has an outstanding balance.' }
  }

  await execute('UPDATE customers SET is_active = 0 WHERE store_id = ? AND id = ?', [storeId, id])
  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'customer',?, 'deactivate', NULL)`,
    [storeId, userId, id],
  )
  return { ok: true }
}

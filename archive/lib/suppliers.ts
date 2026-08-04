import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'

export type SupplierRow = RowDataPacket & {
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
  account_number: string | null
  payment_terms_days: number
  is_active: number
  notes: string | null
  product_count: number
}

export type Supplier = {
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
  accountNumber: string | null
  paymentTermsDays: number
  isActive: boolean
  notes: string | null
  productCount: number
}

function mapSupplier(r: SupplierRow): Supplier {
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
    accountNumber: r.account_number,
    paymentTermsDays: r.payment_terms_days,
    isActive: !!r.is_active,
    notes: r.notes,
    productCount: Number(r.product_count ?? 0),
  }
}

const SELECT_SUPPLIER = `
  SELECT s.id, s.code, s.name, s.contact_name, s.email, s.phone, s.address_line1,
         s.address_line2, s.city, s.postal_code, s.vat_number, s.account_number,
         s.payment_terms_days, s.is_active, s.notes,
         (SELECT COUNT(*) FROM products p
           WHERE p.supplier_id = s.id AND p.is_active = 1) AS product_count
    FROM suppliers s
`

export type SupplierListOptions = {
  search?: string
  includeInactive?: boolean
  limit?: number
  offset?: number
}

export async function listSuppliers(
  storeId: number,
  opts: SupplierListOptions = {},
): Promise<{ items: Supplier[]; total: number }> {
  const where: string[] = ['s.store_id = ?']
  const params: unknown[] = [storeId]

  if (!opts.includeInactive) where.push('s.is_active = 1')
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(s.name LIKE ? OR s.code LIKE ? OR s.email LIKE ? OR s.contact_name LIKE ?)')
    params.push(term, term, term, term)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const rows = await query<SupplierRow>(
    `${SELECT_SUPPLIER} ${whereSql} ORDER BY s.name ASC LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM suppliers s ${whereSql}`,
    params,
  )

  return { items: rows.map(mapSupplier), total: countRow?.total ?? 0 }
}

export async function getSupplier(storeId: number, id: number): Promise<Supplier | null> {
  const row = await queryOne<SupplierRow>(
    `${SELECT_SUPPLIER} WHERE s.store_id = ? AND s.id = ? LIMIT 1`,
    [storeId, id],
  )
  return row ? mapSupplier(row) : null
}

export type SupplierInput = {
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
  accountNumber?: string | null
  paymentTermsDays?: number
  isActive?: boolean
  notes?: string | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateSupplier(input: SupplierInput): string | null {
  if (!input.code?.trim()) return 'A supplier code is required.'
  if (!input.name?.trim()) return 'A supplier name is required.'
  if (input.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    return 'That email address does not look valid.'
  }
  const terms = input.paymentTermsDays ?? 30
  if (terms < 0 || terms > 365) return 'Payment terms must be between 0 and 365 days.'
  return null
}

function inputParams(input: SupplierInput): unknown[] {
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
    input.accountNumber?.trim() || null,
    input.paymentTermsDays ?? 30,
    input.isActive === false ? 0 : 1,
    input.notes?.trim() || null,
  ]
}

export async function createSupplier(
  storeId: number,
  userId: number,
  input: SupplierInput,
): Promise<SaveResult> {
  const invalid = validateSupplier(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM suppliers WHERE store_id = ? AND code = ? LIMIT 1',
    [storeId, code],
  )
  if (clash) return { ok: false, error: `Supplier code "${code}" is already in use.` }

  const res = await execute(
    `INSERT INTO suppliers
       (store_id, code, name, contact_name, email, phone, address_line1, address_line2,
        city, postal_code, vat_number, account_number, payment_terms_days, is_active, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [storeId, ...inputParams(input)],
  )

  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'supplier',?, 'create', ?)`,
    [storeId, userId, res.insertId, `${code} — ${input.name.trim()}`],
  )

  return { ok: true, id: res.insertId }
}

export async function updateSupplier(
  storeId: number,
  userId: number,
  id: number,
  input: SupplierInput,
): Promise<SaveResult> {
  const invalid = validateSupplier(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM suppliers WHERE store_id = ? AND code = ? AND id <> ? LIMIT 1',
    [storeId, code, id],
  )
  if (clash) return { ok: false, error: `Supplier code "${code}" is already in use.` }

  const res = await execute(
    `UPDATE suppliers SET
       code = ?, name = ?, contact_name = ?, email = ?, phone = ?, address_line1 = ?,
       address_line2 = ?, city = ?, postal_code = ?, vat_number = ?, account_number = ?,
       payment_terms_days = ?, is_active = ?, notes = ?
     WHERE store_id = ? AND id = ?`,
    [...inputParams(input), storeId, id],
  )
  if (res.affectedRows === 0) return { ok: false, error: 'Supplier not found.' }

  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'supplier',?, 'update', ?)`,
    [storeId, userId, id, `${code} — ${input.name.trim()}`],
  )

  return { ok: true, id }
}

export async function deactivateSupplier(
  storeId: number,
  userId: number,
  id: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await execute('UPDATE suppliers SET is_active = 0 WHERE store_id = ? AND id = ?', [
    storeId,
    id,
  ])
  if (res.affectedRows === 0) return { ok: false, error: 'Supplier not found.' }
  // Products keep pointing at the supplier — the FK is ON DELETE SET NULL, but
  // we aren't deleting, so linked products stay intact and simply show an
  // inactive supplier.
  await execute(
    `INSERT INTO activity_log (store_id, user_id, entity, entity_id, action, detail)
     VALUES (?,?,'supplier',?, 'deactivate', NULL)`,
    [storeId, userId, id],
  )
  return { ok: true }
}

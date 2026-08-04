import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { toNum } from './decimals'

export type Department = {
  id: number
  code: string
  name: string
  parentId: number | null
  color: string | null
  sortOrder: number
  isActive: boolean
  productCount: number
}

export async function listDepartments(
  storeId: number,
  includeInactive = false,
): Promise<Department[]> {
  const rows = await query<RowDataPacket & Record<string, never>>(
    `SELECT d.id, d.code, d.name, d.parent_id, d.color, d.sort_order, d.is_active,
            (SELECT COUNT(*) FROM products p
              WHERE p.department_id = d.id AND p.is_active = 1) AS product_count
       FROM departments d
      WHERE d.store_id = ? ${includeInactive ? '' : 'AND d.is_active = 1'}
      ORDER BY d.sort_order ASC, d.name ASC`,
    [storeId],
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    color: (r.color as string | null) ?? null,
    sortOrder: Number(r.sort_order),
    isActive: !!r.is_active,
    productCount: Number(r.product_count ?? 0),
  }))
}

export async function createDepartment(
  storeId: number,
  input: { code: string; name: string; parentId?: number | null; color?: string | null },
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!input.code?.trim()) return { ok: false, error: 'A department code is required.' }
  if (!input.name?.trim()) return { ok: false, error: 'A department name is required.' }

  const code = input.code.trim()
  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM departments WHERE store_id = ? AND code = ? LIMIT 1',
    [storeId, code],
  )
  if (clash) return { ok: false, error: `Department code "${code}" is already in use.` }

  const res = await execute(
    'INSERT INTO departments (store_id, code, name, parent_id, color) VALUES (?,?,?,?,?)',
    [storeId, code, input.name.trim(), input.parentId ?? null, input.color ?? null],
  )
  return { ok: true, id: res.insertId }
}

export type VatRate = {
  id: number
  code: string
  name: string
  rate: number
  isDefault: boolean
}

export async function listVatRates(storeId: number): Promise<VatRate[]> {
  const rows = await query<RowDataPacket>(
    `SELECT id, code, name, rate, is_default FROM vat_rates
      WHERE store_id = ? ORDER BY is_default DESC, rate DESC`,
    [storeId],
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    rate: toNum(r.rate),
    isDefault: !!r.is_default,
  }))
}

export type Store = {
  id: number
  code: string
  name: string
  tradingName: string | null
  currency: string
  timezone: string
  status: 'active' | 'suspended' | 'closed'
}

export async function listStores(): Promise<Store[]> {
  const rows = await query<RowDataPacket>(
    `SELECT id, code, name, trading_name, currency, timezone, status
       FROM stores ORDER BY name ASC`,
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    tradingName: (r.trading_name as string | null) ?? null,
    currency: String(r.currency),
    timezone: String(r.timezone),
    status: r.status as Store['status'],
  }))
}

export async function getStore(id: number): Promise<Store | null> {
  const stores = await listStores()
  return stores.find((s) => s.id === id) ?? null
}

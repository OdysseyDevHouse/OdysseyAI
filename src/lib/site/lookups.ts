import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import type { CostBasis } from '../pricing'

// Departments live in ./departments — they have their own writes and tree
// helpers, and keeping them here would make this file the place everything
// lands by default.

// ── Brands ──────────────────────────────────────────────────────────────

export type Brand = { id: number; name: string; isActive: boolean }

export async function listBrands(siteId: number): Promise<Brand[]> {
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    'SELECT id, name, is_active FROM brands WHERE is_active = 1 ORDER BY name ASC',
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    isActive: !!r.is_active,
  }))
}

// ── VAT ─────────────────────────────────────────────────────────────────

export type VatType = 'sales' | 'purchase'

export type VatRate = {
  id: number
  vatType: VatType
  code: string
  name: string
  rate: number
  isDefault: boolean
}

export async function listVatRates(siteId: number): Promise<VatRate[]> {
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    `SELECT id, vat_type, code, name, rate, is_default
       FROM vat_rates WHERE is_active = 1
      ORDER BY vat_type ASC, is_default DESC, rate DESC`,
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    vatType: r.vat_type as VatType,
    code: String(r.code),
    name: String(r.name),
    rate: toNum(r.rate),
    isDefault: !!r.is_default,
  }))
}

export function defaultVat(rates: VatRate[], type: VatType): VatRate | null {
  const ofType = rates.filter((r) => r.vatType === type)
  return ofType.find((r) => r.isDefault) ?? ofType[0] ?? null
}

// ── Price structures ────────────────────────────────────────────────────

export type PriceStructure = {
  id: number
  position: number
  name: string
  isDefault: boolean
}

export async function listPriceStructures(siteId: number): Promise<PriceStructure[]> {
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    `SELECT id, position, name, is_default
       FROM price_structures WHERE is_active = 1 ORDER BY position ASC`,
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    position: Number(r.position),
    name: String(r.name),
    isDefault: !!r.is_default,
  }))
}

// ── Sales reps ──────────────────────────────────────────────────────────

export type SalesRep = { id: number; name: string; code: string | null }

/** Active reps, for the clerk picker on an invoice line. */
export async function listSalesReps(siteId: number): Promise<SalesRep[]> {
  const rows = await siteQuery<RowDataPacket>(
    siteId,
    'SELECT id, name, code FROM sales_reps WHERE is_active = 1 ORDER BY name ASC',
  )
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    code: (r.code as string | null) ?? null,
  }))
}

// ── Settings ────────────────────────────────────────────────────────────

/** Which cost figure this site prices from. Defaults to average. */
export async function getCostBasis(siteId: number): Promise<CostBasis> {
  const row = await siteQueryOne<RowDataPacket & { setting_value: string | null }>(
    siteId,
    "SELECT setting_value FROM settings WHERE setting_key = 'cost_basis' LIMIT 1",
  )
  return row?.setting_value === 'last' ? 'last' : 'average'
}

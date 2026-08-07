import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { toNum } from '../decimals'

/**
 * Writes for the two lookup tables that price a line: VAT rates and price
 * structures. Reads live in ./lookups — the till, the product form and the
 * storefront all pull from there, and this module exists only so the setup
 * screen can change them.
 *
 * The reason this file is careful out of proportion to its size: both tables
 * are pointed at by FKs that are SET NULL or CASCADE, never RESTRICT. The
 * database will happily let you delete a price structure and take every
 * product price under it along for the ride. Every guard below is therefore
 * application-level — there is no constraint underneath to catch a mistake.
 *
 * History is safe from edits here, and deliberately so: sales lines snapshot
 * `vat_rate_pct` rather than referencing vat_rates, so changing 15% to 16%
 * next year reprices the future and leaves every issued invoice alone.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Sites are migrated independently, so a table this module wants to consult may
 * not exist yet on every one of them — product_store_prices arrives with the
 * multi-branch migration, which a single-store site has never needed.
 *
 * A missing table must not crash the guard it is part of, and must not be read
 * as "nothing references this" either. Probing first and returning null lets
 * the caller tell the two apart: a number is a real count, null means the
 * question could not be asked.
 */
async function countIfTableExists(
  siteId: number,
  table: string,
  where: string,
  params: unknown[],
): Promise<number | null> {
  // information_schema rather than SHOW TABLES: the latter takes no placeholder
  // in a prepared statement, and a table name is not something to interpolate.
  const exists = await siteQueryOne<Row & { n: number }>(
    siteId,
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  )
  if (Number(exists?.n ?? 0) === 0) return null
  const row = await siteQueryOne<Row & { n: number }>(
    siteId,
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`,
    params,
  )
  return Number(row?.n ?? 0)
}

/* ── VAT rates ───────────────────────────────────────────────────────────── */

export type VatType = 'sales' | 'purchase'

export type VatRateRow = {
  id: number
  vatType: VatType
  code: string
  name: string
  rate: number
  isDefault: boolean
  isActive: boolean
  /** How many products point at it — the setup screen shows this before a delete. */
  productCount: number
}

export type VatRateInput = {
  vatType: VatType
  code: string
  name: string
  rate: number
  isDefault?: boolean
  isActive?: boolean
}

/**
 * Every rate including the inactive ones, with usage counts.
 *
 * The counts are correlated subqueries rather than joins: a product can point
 * at the same rate from both its buying and selling column, and a join would
 * double-count it.
 */
export async function listVatRatesForSetup(siteId: number): Promise<VatRateRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT v.id, v.vat_type, v.code, v.name, v.rate, v.is_default, v.is_active,
            (SELECT COUNT(*) FROM products p
              WHERE p.selling_vat_rate_id = v.id OR p.purchase_vat_rate_id = v.id) AS product_count
       FROM vat_rates v
      ORDER BY v.vat_type ASC, v.rate DESC, v.code ASC`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    vatType: r.vat_type as VatType,
    code: String(r.code),
    name: String(r.name),
    rate: toNum(r.rate),
    isDefault: !!r.is_default,
    isActive: !!r.is_active,
    productCount: Number(r.product_count ?? 0),
  }))
}

export async function getVatRate(siteId: number, id: number): Promise<VatRateRow | null> {
  const all = await listVatRatesForSetup(siteId)
  return all.find((r) => r.id === id) ?? null
}

export function validateVatRate(input: VatRateInput): string | null {
  if (input.vatType !== 'sales' && input.vatType !== 'purchase') {
    return 'Choose whether this rate applies to sales or to purchases.'
  }
  if (!input.code?.trim()) return 'A code is required.'
  if (!/^[A-Z0-9_]{1,16}$/.test(input.code.trim().toUpperCase())) {
    return 'Code must be 1–16 characters, letters, digits and underscores only.'
  }
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 60) return 'Name must be 60 characters or fewer.'

  if (!Number.isFinite(input.rate)) return 'Enter a percentage.'
  if (input.rate < 0) return 'A VAT rate cannot be negative.'
  // 999.999 is what DECIMAL(6,3) holds; anything near it is a typo — someone
  // entering 15 as 1500 should be told, not silently saved.
  if (input.rate > 100) return 'A VAT rate cannot be above 100%. Enter 15 for 15%, not 0.15.'
  return null
}

/**
 * Exactly one default per vat_type. Cleared in the same transaction-less pass
 * the caller uses to set the new one — the window between is a single query,
 * and a site has one person in Setup at a time.
 */
async function clearOtherDefaults(
  siteId: number,
  vatType: VatType,
  keepId: number | null,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE vat_rates SET is_default = 0
      WHERE vat_type = ? AND is_default = 1 ${keepId ? 'AND id <> ?' : ''}`,
    keepId ? [vatType, keepId] : [vatType],
  )
}

export async function createVatRate(siteId: number, input: VatRateInput): Promise<SaveResult> {
  const invalid = validateVatRate(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM vat_rates WHERE vat_type = ? AND code = ? LIMIT 1',
    [input.vatType, code],
  )
  if (clash) {
    return { ok: false, error: `A ${input.vatType} rate with code "${code}" already exists.` }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO vat_rates (vat_type, code, name, rate, is_default, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.vatType,
      code,
      input.name.trim(),
      input.rate.toFixed(3),
      input.isDefault ? 1 : 0,
      input.isActive === false ? 0 : 1,
    ],
  )
  if (input.isDefault) await clearOtherDefaults(siteId, input.vatType, res.insertId)
  return { ok: true, id: res.insertId }
}

/**
 * Updates a rate.
 *
 * The vat_type is fixed after creation: a product's selling and buying columns
 * are filled from two different lists, and flipping a rate from one list to the
 * other would leave products pointing at a rate that no longer belongs to the
 * column that selected it.
 */
export async function updateVatRate(
  siteId: number,
  id: number,
  input: VatRateInput,
): Promise<SaveResult> {
  const existing = await getVatRate(siteId, id)
  if (!existing) return { ok: false, error: 'VAT rate not found.' }

  const effective: VatRateInput = { ...input, vatType: existing.vatType }
  const invalid = validateVatRate(effective)
  if (invalid) return { ok: false, error: invalid }

  const code = effective.code.trim().toUpperCase()
  if (code !== existing.code) {
    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM vat_rates WHERE vat_type = ? AND code = ? AND id <> ? LIMIT 1',
      [existing.vatType, code, id],
    )
    if (clash) {
      return { ok: false, error: `A ${existing.vatType} rate with code "${code}" already exists.` }
    }
  }

  // Turning off the last active rate of a type would leave the product form
  // with an empty dropdown and no way to price anything.
  if (effective.isActive === false && existing.isActive) {
    const others = await siteQueryOne<Row & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM vat_rates WHERE vat_type = ? AND is_active = 1 AND id <> ?',
      [existing.vatType, id],
    )
    if (Number(others?.n ?? 0) === 0) {
      return {
        ok: false,
        error: `${existing.name} is the only active ${existing.vatType} rate. Add another before turning this one off.`,
      }
    }
  }

  // A default must stay selectable, or the product form defaults to something
  // it cannot show.
  const isDefault = effective.isDefault && effective.isActive !== false

  await siteExecute(
    siteId,
    `UPDATE vat_rates SET code = ?, name = ?, rate = ?, is_default = ?, is_active = ?
      WHERE id = ?`,
    [
      code,
      effective.name.trim(),
      effective.rate.toFixed(3),
      isDefault ? 1 : 0,
      effective.isActive === false ? 0 : 1,
      id,
    ],
  )
  if (isDefault) await clearOtherDefaults(siteId, existing.vatType, id)
  return { ok: true, id }
}

/**
 * Deletes a rate.
 *
 * Refused while products point at it. The FK is ON DELETE SET NULL, so the
 * database would accept this and quietly blank the VAT rate on every affected
 * product — they would then post at 0% with nothing to show it had happened.
 * Issued documents are unaffected either way; they snapshot the percentage.
 */
export async function deleteVatRate(siteId: number, id: number): Promise<DeleteResult> {
  const rate = await getVatRate(siteId, id)
  if (!rate) return { ok: false, error: 'VAT rate not found.' }

  if (rate.productCount > 0) {
    return {
      ok: false,
      error: `${rate.name} is used by ${rate.productCount} product${rate.productCount === 1 ? '' : 's'}. Move them to another rate first, or turn this one off instead.`,
    }
  }

  const inCategories = await siteQueryOne<Row & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM expense_categories WHERE default_vat_rate_id = ?',
    [id],
  )
  if (Number(inCategories?.n ?? 0) > 0) {
    return {
      ok: false,
      error: `${rate.name} is the default on ${inCategories!.n} expense categor${Number(inCategories!.n) === 1 ? 'y' : 'ies'}. Change those first, or turn this rate off instead.`,
    }
  }

  const activeSiblings = await siteQueryOne<Row & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM vat_rates WHERE vat_type = ? AND is_active = 1 AND id <> ?',
    [rate.vatType, id],
  )
  if (rate.isActive && Number(activeSiblings?.n ?? 0) === 0) {
    return {
      ok: false,
      error: `${rate.name} is the only active ${rate.vatType} rate. Add another before deleting it.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM vat_rates WHERE id = ?', [id])

  // Deleting the default leaves the type without one; promote the highest
  // remaining rate rather than leaving the product form to pick arbitrarily.
  if (rate.isDefault) {
    const next = await siteQueryOne<Row>(
      siteId,
      `SELECT id FROM vat_rates WHERE vat_type = ? AND is_active = 1
        ORDER BY rate DESC, id ASC LIMIT 1`,
      [rate.vatType],
    )
    if (next) {
      await siteExecute(siteId, 'UPDATE vat_rates SET is_default = 1 WHERE id = ?', [Number(next.id)])
    }
  }
  return { ok: true }
}

/* ── Price structures ────────────────────────────────────────────────────── */

export type PriceStructureRow = {
  id: number
  position: number
  name: string
  isDefault: boolean
  isActive: boolean
  /** Products carrying a price under this structure. */
  priceCount: number
  /** Customer groups that price off it. */
  groupCount: number
  /** True when the online store sells at this structure. */
  usedOnline: boolean
}

export type PriceStructureInput = {
  name: string
  isDefault?: boolean
  isActive?: boolean
}

export async function listPriceStructuresForSetup(siteId: number): Promise<PriceStructureRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.position, s.name, s.is_default, s.is_active,
            (SELECT COUNT(*) FROM product_prices pp
              WHERE pp.price_structure_id = s.id) AS price_count,
            (SELECT COUNT(*) FROM customer_groups cg
              WHERE cg.price_structure_id = s.id) AS group_count,
            (SELECT COUNT(*) FROM online_store_settings o
              WHERE o.price_structure_id = s.id) AS online_count
       FROM price_structures s
      ORDER BY s.position ASC, s.id ASC`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    position: Number(r.position),
    name: String(r.name),
    isDefault: !!r.is_default,
    isActive: !!r.is_active,
    priceCount: Number(r.price_count ?? 0),
    groupCount: Number(r.group_count ?? 0),
    usedOnline: Number(r.online_count ?? 0) > 0,
  }))
}

export async function getPriceStructure(
  siteId: number,
  id: number,
): Promise<PriceStructureRow | null> {
  const all = await listPriceStructuresForSetup(siteId)
  return all.find((s) => s.id === id) ?? null
}

export function validatePriceStructure(input: PriceStructureInput): string | null {
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 60) return 'Name must be 60 characters or fewer.'
  return null
}

async function clearOtherStructureDefaults(siteId: number, keepId: number | null): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE price_structures SET is_default = 0
      WHERE is_default = 1 ${keepId ? 'AND id <> ?' : ''}`,
    keepId ? [keepId] : [],
  )
}

/**
 * Adds a structure at the end of the list.
 *
 * `position` is UNIQUE and is the stable external handle — imports and the
 * storefront address a tier by it — so it is assigned here rather than taken
 * from the caller, and never reused.
 */
export async function createPriceStructure(
  siteId: number,
  input: PriceStructureInput,
): Promise<SaveResult> {
  const invalid = validatePriceStructure(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM price_structures WHERE name = ? LIMIT 1',
    [name],
  )
  if (clash) return { ok: false, error: `A price type called "${name}" already exists.` }

  const top = await siteQueryOne<Row & { max_pos: number | null }>(
    siteId,
    'SELECT MAX(position) AS max_pos FROM price_structures',
  )
  const position = Number(top?.max_pos ?? 0) + 1

  const res = await siteExecute(
    siteId,
    `INSERT INTO price_structures (position, name, is_default, is_active) VALUES (?, ?, ?, ?)`,
    [position, name, input.isDefault ? 1 : 0, input.isActive === false ? 0 : 1],
  )
  if (input.isDefault) await clearOtherStructureDefaults(siteId, res.insertId)
  return { ok: true, id: res.insertId }
}

export async function updatePriceStructure(
  siteId: number,
  id: number,
  input: PriceStructureInput,
): Promise<SaveResult> {
  const existing = await getPriceStructure(siteId, id)
  if (!existing) return { ok: false, error: 'Price type not found.' }

  const invalid = validatePriceStructure(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  if (name !== existing.name) {
    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM price_structures WHERE name = ? AND id <> ? LIMIT 1',
      [name, id],
    )
    if (clash) return { ok: false, error: `A price type called "${name}" already exists.` }
  }

  const turningOff = input.isActive === false && existing.isActive
  if (turningOff) {
    if (existing.isDefault) {
      return {
        ok: false,
        error: `${existing.name} is the default price type. Make another one the default before turning it off.`,
      }
    }
    const others = await siteQueryOne<Row & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM price_structures WHERE is_active = 1 AND id <> ?',
      [id],
    )
    if (Number(others?.n ?? 0) === 0) {
      return { ok: false, error: 'At least one price type must stay active.' }
    }
    // Not a refusal: the prices are kept and reappear if it is turned back on.
    // But a group priced off a hidden structure silently falls back to the
    // default, so the operator is told rather than left to discover it.
    if (existing.usedOnline) {
      return {
        ok: false,
        error: `${existing.name} is what the online store sells at. Point the store at another price type first (Online Store → Settings).`,
      }
    }
  }

  const isDefault = input.isDefault && input.isActive !== false

  await siteExecute(
    siteId,
    'UPDATE price_structures SET name = ?, is_default = ?, is_active = ? WHERE id = ?',
    [name, isDefault ? 1 : 0, input.isActive === false ? 0 : 1, id],
  )
  if (isDefault) await clearOtherStructureDefaults(siteId, id)
  return { ok: true, id }
}

/**
 * Deletes a price structure.
 *
 * The strictest guard in this file, because the FK on product_prices is ON
 * DELETE CASCADE: dropping a structure that 1,284 products are priced under
 * would delete 1,284 prices with no warning and no way back. Refused outright
 * while any price exists — deactivating keeps the rows and is reversible.
 */
export async function deletePriceStructure(siteId: number, id: number): Promise<DeleteResult> {
  const structure = await getPriceStructure(siteId, id)
  if (!structure) return { ok: false, error: 'Price type not found.' }

  if (structure.isDefault) {
    return {
      ok: false,
      error: `${structure.name} is the default price type. Make another one the default before deleting it.`,
    }
  }

  if (structure.priceCount > 0) {
    return {
      ok: false,
      error: `${structure.priceCount} product price${structure.priceCount === 1 ? ' is' : 's are'} stored under ${structure.name}. Deleting it would delete them. Turn it off instead — the prices are kept.`,
    }
  }

  if (structure.groupCount > 0) {
    return {
      ok: false,
      error: `${structure.groupCount} customer group${structure.groupCount === 1 ? '' : 's'} price${structure.groupCount === 1 ? 's' : ''} off ${structure.name}. Move them to another price type first.`,
    }
  }

  if (structure.usedOnline) {
    return {
      ok: false,
      error: `${structure.name} is what the online store sells at. Point the store at another price type first (Online Store → Settings).`,
    }
  }

  // Store-specific overrides also CASCADE. They are per-branch prices rather
  // than the master list, so they get their own sentence. The table only exists
  // on sites that have taken the multi-branch migration.
  const overrides = await countIfTableExists(
    siteId,
    'product_store_prices',
    'price_structure_id = ?',
    [id],
  )
  if (overrides !== null && overrides > 0) {
    return {
      ok: false,
      error: `${overrides} branch price override${overrides === 1 ? '' : 's'} use ${structure.name}. Turn it off instead — deleting it would delete them.`,
    }
  }

  const others = await siteQueryOne<Row & { n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM price_structures WHERE id <> ?',
    [id],
  )
  if (Number(others?.n ?? 0) === 0) {
    return { ok: false, error: 'A site needs at least one price type.' }
  }

  await siteExecute(siteId, 'DELETE FROM price_structures WHERE id = ?', [id])
  return { ok: true }
}

/**
 * Persists the up/down order.
 *
 * `position` is UNIQUE, so the rows cannot be renumbered in place — writing
 * position 2 onto a row while another still holds 2 trips the constraint
 * mid-loop and leaves the list half-reordered. The offset pass parks every row
 * above the current maximum first, then brings them down into their new slots.
 */
export async function reorderPriceStructures(siteId: number, orderedIds: number[]): Promise<void> {
  if (orderedIds.length === 0) return

  const top = await siteQueryOne<Row & { max_pos: number | null }>(
    siteId,
    'SELECT MAX(position) AS max_pos FROM price_structures',
  )
  const offset = Number(top?.max_pos ?? 0) + 1

  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE price_structures SET position = ? WHERE id = ?', [
      offset + index,
      id,
    ])
  }
  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE price_structures SET position = ? WHERE id = ?', [
      index + 1,
      id,
    ])
  }
}

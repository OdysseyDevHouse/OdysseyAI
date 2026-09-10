import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'

/**
 * The brand list.
 *
 * A brand is the plainest lookup in the catalogue — a name and an active flag,
 * and nothing branches on it. It earns a table rather than a free-text column
 * because several screens SCOPE by it: commission rules, stock-take and
 * cycle-count scope, bulk repricing, storefront collections and the report
 * builder all point at `brands.id`. A typed string cannot be pointed at.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
 *
 * The table has been in 001 since the beginning and the only writes to it in
 * the whole repo were four seed scripts. Everything else read it — so a brand
 * could be selected, filtered on, commissioned against and reported on, and
 * there was no way to create one outside of SQL. The product importer even
 * refuses to invent brands and tells the user to "add it under Setup", naming
 * a screen that did not exist. This is the model layer that screen needed.
 *
 * ── THE NAME IS THE IDENTITY ─────────────────────────────────────────────
 *
 * `uq_brand_name` is a UNIQUE over the whole table, not per anything, so the
 * clash check here is global. That is deliberate and matches why the importer
 * refuses to auto-create: 'Coca Cola', 'Coca-Cola' and 'CocaCola' would become
 * three brands and split the catalogue permanently, with nothing to catch it.
 * A department path has structure to match on; a brand name does not.
 */

type Row = RowDataPacket & Record<string, unknown>

export type Brand = {
  id: number
  name: string
  isActive: boolean
  /** How many products carry this brand. Drives the delete refusal. */
  productCount: number
  /**
   * The shop picture, or null. A raw id, not the resolved image: the row can
   * name a picture that has since been deleted (253 keeps no FK on purpose),
   * so a reader that needs to SHOW it resolves the id and falls back to
   * nothing. Only the brand form does that.
   */
  onlineImageId: number | null
}

export type BrandInput = {
  name: string
  isActive: boolean
  onlineImageId: number | null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Every brand, with the number of products on each.
 *
 * `includeInactive` exists for the setup screen and nowhere else — that is the
 * screen that brings a brand back, so hiding the inactive ones there would make
 * reviving one impossible. Every other caller uses `listBrands()` in lookups.ts,
 * which returns the active ones only.
 *
 * LEFT JOIN, not a subquery per row: a brand with no products must still appear
 * — it is the one somebody just created.
 */
export async function listBrandsForSetup(
  siteId: number,
  includeInactive = false,
): Promise<Brand[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT b.id, b.name, b.is_active, b.online_image_id, COUNT(p.id) AS product_count
       FROM brands b
       LEFT JOIN products p ON p.brand_id = b.id
      ${includeInactive ? '' : 'WHERE b.is_active = 1'}
      GROUP BY b.id, b.name, b.is_active, b.online_image_id
      ORDER BY b.name ASC`,
  )
  return rows.map(mapBrand)
}

/** One row to a Brand. Shared so the list and the single read cannot drift. */
function mapBrand(r: Row): Brand {
  return {
    id: Number(r.id),
    name: String(r.name),
    isActive: !!r.is_active,
    productCount: Number(r.product_count ?? 0),
    onlineImageId: r.online_image_id === null ? null : Number(r.online_image_id),
  }
}

export async function getBrand(siteId: number, id: number): Promise<Brand | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT b.id, b.name, b.is_active, b.online_image_id, COUNT(p.id) AS product_count
       FROM brands b
       LEFT JOIN products p ON p.brand_id = b.id
      WHERE b.id = ?
      GROUP BY b.id, b.name, b.is_active, b.online_image_id`,
    [id],
  )
  return row ? mapBrand(row) : null
}

/**
 * A picture id posted by a form, or null.
 *
 * An empty field means "no picture" and must not become 0 — a 0 would be stored
 * as a real id that resolves to nothing, which reads as a broken picture rather
 * than as no picture at all.
 */
function imageId(value: number | null | undefined): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function validateBrand(input: BrandInput): string | null {
  if (!input.name?.trim()) return 'A brand name is required.'
  // 120 is the column width. Letting a longer name through means MariaDB
  // truncates it silently rather than the user being told.
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  return null
}

/**
 * Whether another brand already holds this name.
 *
 * Checked here rather than left to the UNIQUE key so the user gets a sentence
 * instead of a driver error. `excludeId` is what makes saving a brand under its
 * own unchanged name work.
 */
async function nameClash(siteId: number, name: string, excludeId?: number): Promise<boolean> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM brands WHERE name = ? ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
    excludeId ? [name, excludeId] : [name],
  )
  return !!row
}

export async function createBrand(siteId: number, input: BrandInput): Promise<SaveResult> {
  const invalid = validateBrand(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  if (await nameClash(siteId, name)) {
    return { ok: false, error: `"${name}" already exists.` }
  }

  const res = await siteExecute(
    siteId,
    'INSERT INTO brands (name, is_active, online_image_id) VALUES (?,?,?)',
    [name, input.isActive === false ? 0 : 1, imageId(input.onlineImageId)],
  )
  return { ok: true, id: res.insertId }
}

export async function updateBrand(
  siteId: number,
  id: number,
  input: BrandInput,
): Promise<SaveResult> {
  const invalid = validateBrand(input)
  if (invalid) return { ok: false, error: invalid }

  const name = input.name.trim()
  if (!(await getBrand(siteId, id))) return { ok: false, error: 'That brand no longer exists.' }
  if (await nameClash(siteId, name, id)) {
    return { ok: false, error: `"${name}" already exists.` }
  }

  await siteExecute(
    siteId,
    'UPDATE brands SET name = ?, is_active = ?, online_image_id = ? WHERE id = ?',
    [name, input.isActive === false ? 0 : 1, imageId(input.onlineImageId), id],
  )
  return { ok: true, id }
}

/** Flips the active flag without touching the name. Used by the list's switch. */
export async function setBrandActive(
  siteId: number,
  id: number,
  isActive: boolean,
): Promise<DeleteResult> {
  if (!(await getBrand(siteId, id))) return { ok: false, error: 'That brand no longer exists.' }
  await siteExecute(siteId, 'UPDATE brands SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id])
  return { ok: true }
}

/**
 * Deletes a brand only when no product carries it.
 *
 * `fk_product_brand` is ON DELETE SET NULL, so deleting a brand in use would
 * succeed and silently clear the brand off every product on it — the products
 * survive, their brand does not, and nothing says so. There is no undo for that
 * because the old value is gone. So this refuses, names the count, and points
 * at deactivating instead: an inactive brand keeps every product's brand_id
 * intact and simply stops being offered on new ones.
 */
export async function deleteBrand(siteId: number, id: number): Promise<DeleteResult> {
  const brand = await getBrand(siteId, id)
  if (!brand) return { ok: false, error: 'Brand not found.' }

  if (brand.productCount > 0) {
    return {
      ok: false,
      error: `${brand.productCount} product${
        brand.productCount === 1 ? ' is' : 's are'
      } still on "${brand.name}". Move ${
        brand.productCount === 1 ? 'it' : 'them'
      } first, or deactivate this brand instead.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM brands WHERE id = ?', [id])
  return { ok: true }
}

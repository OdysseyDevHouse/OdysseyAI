import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'

/**
 * The places stock is kept, inside one site.
 *
 * A wholesaler with three stock rooms holds one product in three piles.
 * `products.stock_on_hand` is the total across all of them; the pile itself
 * lives in `product_location_stock`, and stockMovements.ts is what keeps the
 * two in step.
 *
 * ── A LOCATION IS NOT A STORE ──────────────────────────────────────────────
 *
 * 003_drop_stores.sql reverted an earlier `stores` table because a STORE is a
 * separate site with its own database, matched to its siblings by product
 * code in the control database. That reasoning still stands and nothing here
 * disturbs it. A LOCATION is the other shape: rooms within one site sharing a
 * database, a product row, a document set and a VAT number.
 *
 * Keeping the words apart is load-bearing. The moment these are called stores
 * again, someone will try to link them across databases.
 */

export type StockLocation = {
  id: number
  code: string
  name: string
  /** Where sales come from, and where anything unallocated lands. Exactly one. */
  isMain: boolean
  isActive: boolean
  address: string | null
  note: string | null
  sortOrder: number
  /** Products holding a non-zero pile here. Shown before offering to delete. */
  productCount: number
  /** Movements recorded against it — the history that makes deletion refuseable. */
  movementCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapLocation(r: Row): StockLocation {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    isMain: !!r.is_main,
    isActive: !!r.is_active,
    address: (r.address as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    productCount: Number(r.product_count ?? 0),
    movementCount: Number(r.movement_count ?? 0),
  }
}

/*
 * Both counts are correlated subqueries rather than joins: a join would
 * multiply the location row by its piles and need a GROUP BY to undo, and the
 * list is short enough that the planner does the right thing either way.
 *
 * product_count counts piles that are NOT zero. A product carrying a 0.000 row
 * for every location is an artefact of the backfill, not a reason to refuse a
 * deletion.
 */
const SELECT_LOCATION = `
  SELECT l.id, l.code, l.name, l.is_main, l.is_active, l.address, l.note, l.sort_order,
         (SELECT COUNT(*) FROM product_location_stock pls
           WHERE pls.location_id = l.id AND pls.stock_on_hand <> 0) AS product_count,
         (SELECT COUNT(*) FROM stock_movements m
           WHERE m.location_id = l.id)                              AS movement_count
    FROM stock_locations l
`

export async function listLocations(
  siteId: number,
  includeInactive = true,
): Promise<StockLocation[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LOCATION}
      ${includeInactive ? '' : 'WHERE l.is_active = 1'}
      ORDER BY l.is_main DESC, l.sort_order ASC, l.code ASC`,
  )
  return rows.map(mapLocation)
}

export async function getLocation(siteId: number, id: number): Promise<StockLocation | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_LOCATION} WHERE l.id = ? LIMIT 1`, [id])
  return row ? mapLocation(row) : null
}

/**
 * The main location, as a row.
 *
 * ORDER BY id keeps the answer stable if two rows ever carry is_main = 1 —
 * setMainLocation() makes that impossible, but a caller that silently picked a
 * different winner each call would turn a data problem into a drifting one.
 */
export async function getMainLocation(siteId: number): Promise<StockLocation | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_LOCATION} WHERE l.is_main = 1 ORDER BY l.id ASC LIMIT 1`,
  )
  return row ? mapLocation(row) : null
}

/**
 * The id every stock path falls back to.
 *
 * Hot: recordMovement() calls this for any movement that does not name a
 * location, which is every sale. Kept to one indexed row read rather than
 * reusing getMainLocation(), whose two subqueries scan tables this does not
 * need.
 *
 * Throws rather than returning null. A site with no main location cannot post
 * stock at all, and 025_stock_locations.sql seeds one — so reaching this is a
 * broken database, not a case a caller can sensibly handle. Failing loudly
 * here beats writing movements to location NULL and discovering it at the next
 * reconciliation.
 */
export async function mainLocationId(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id ASC LIMIT 1',
  )
  if (!row) {
    throw new Error(
      'This site has no main stock location. Run sql/site/025_stock_locations.sql before posting stock.',
    )
  }
  return Number(row.id)
}

/** Same, inside a caller's open transaction — so a movement cannot straddle a change of main. */
export async function mainLocationIdTx(tx: PoolConnection): Promise<number> {
  const [rows] = await tx.execute(
    'SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id ASC LIMIT 1',
  )
  const row = (rows as Row[])[0]
  if (!row) {
    throw new Error(
      'This site has no main stock location. Run sql/site/025_stock_locations.sql before posting stock.',
    )
  }
  return Number(row.id)
}

export type LocationInput = {
  code: string
  name: string
  address?: string | null
  note?: string | null
  isActive?: boolean
  sortOrder?: number
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

export function validateLocation(input: LocationInput): string | null {
  if (!input.code?.trim()) return 'A location code is required.'
  // Prints on a picking slip and groups every stock report, so it has to be
  // short and predictable — the same rule terminals use for the same reason.
  if (!/^[A-Z0-9-]{2,24}$/.test(input.code.trim().toUpperCase())) {
    return 'Code must be 2–24 characters, letters, digits and hyphens only.'
  }
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  return null
}

export async function createLocation(siteId: number, input: LocationInput): Promise<SaveResult> {
  const invalid = validateLocation(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM stock_locations WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `A location with code "${code}" already exists.` }

  // Never is_main. A new location becomes main only through setMainLocation(),
  // which is the one place that can clear the incumbent in the same breath.
  const res = await siteExecute(
    siteId,
    `INSERT INTO stock_locations (code, name, address, note, is_main, is_active, sort_order)
     VALUES (?,?,?,?,0,?,?)`,
    [
      code,
      input.name.trim(),
      input.address?.trim() || null,
      input.note?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? 0,
    ],
  )
  return { ok: true, id: res.insertId }
}

/**
 * Edits a location. Cannot change which one is main, and cannot deactivate the
 * main one — see setMainLocation() and the deactivation guard below.
 */
export async function updateLocation(
  siteId: number,
  id: number,
  input: LocationInput,
): Promise<SaveResult> {
  const invalid = validateLocation(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getLocation(siteId, id)
  if (!existing) return { ok: false, error: 'Location not found.' }

  const code = input.code.trim().toUpperCase()
  if (code !== existing.code) {
    const clash = await siteQueryOne<RowDataPacket & { id: number }>(
      siteId,
      'SELECT id FROM stock_locations WHERE code = ? AND id <> ? LIMIT 1',
      [code, id],
    )
    if (clash) return { ok: false, error: `A location with code "${code}" already exists.` }
  }

  // Deactivating the main location would leave every sale and every
  // unallocated receipt pointing at a place the UI refuses to offer. Moving
  // main elsewhere first is the deliberate order of operations.
  if (existing.isMain && input.isActive === false) {
    return {
      ok: false,
      error:
        'The main location cannot be deactivated. Make another location the main one first, then deactivate this.',
    }
  }

  await siteExecute(
    siteId,
    `UPDATE stock_locations
        SET code = ?, name = ?, address = ?, note = ?, is_active = ?, sort_order = ?
      WHERE id = ?`,
    [
      code,
      input.name.trim(),
      input.address?.trim() || null,
      input.note?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? existing.sortOrder,
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * Moves "main" to another location.
 *
 * THE SINGLE-MAIN RULE LIVES HERE. MariaDB cannot express "unique among rows
 * where is_main = 1" — a partial index is Postgres — so the clear-then-set
 * runs inside ONE transaction. Two statements outside a transaction would
 * leave a window with no main location at all, and mainLocationId() throws in
 * that window, which would fail live sales.
 *
 * Deliberately does NOT move stock. Naming a different room as the sales
 * source does not carry the goods there; the piles stay exactly where they
 * are and a transfer is what moves them. Silently relocating stock on a
 * settings change would falsify both piles at once.
 */
export async function setMainLocation(siteId: number, id: number): Promise<SaveResult> {
  const target = await getLocation(siteId, id)
  if (!target) return { ok: false, error: 'Location not found.' }

  if (!target.isActive) {
    return { ok: false, error: `${target.name} is deactivated. Activate it before making it main.` }
  }
  if (target.isMain) return { ok: true, id }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('UPDATE stock_locations SET is_main = 0 WHERE is_main = 1', [] as never)
    await tx.execute('UPDATE stock_locations SET is_main = 1 WHERE id = ?', [id] as never)
  })

  return { ok: true, id }
}

/**
 * Deletes a location, but only when no stock and no history point at it.
 *
 * Both FKs into it are ON DELETE RESTRICT, so the database would refuse this
 * anyway — the point of checking first is to say WHICH of the two reasons
 * applies, rather than surfacing a constraint name to a user.
 *
 * Movement history is the stricter of the two: a pile can be emptied by a
 * transfer, but a movement that happened in this location happened, and
 * deleting the row it names would make Σ per location unverifiable.
 */
export async function deleteLocation(siteId: number, id: number): Promise<DeleteResult> {
  const location = await getLocation(siteId, id)
  if (!location) return { ok: false, error: 'Location not found.' }

  if (location.isMain) {
    return {
      ok: false,
      error:
        'The main location cannot be deleted. Make another location the main one first, then delete this.',
    }
  }

  if (location.movementCount > 0) {
    return {
      ok: false,
      error: `${location.name} has ${location.movementCount} stock movement${
        location.movementCount === 1 ? '' : 's'
      } against it. Deactivate it instead — deleting it would break the stock history.`,
    }
  }

  if (location.productCount > 0) {
    return {
      ok: false,
      error: `${location.name} still holds stock on ${location.productCount} product${
        location.productCount === 1 ? '' : 's'
      }. Transfer it out before deleting this location.`,
    }
  }

  // Only zero-quantity piles can remain, and those are backfill artefacts
  // carrying no information. Clearing them lets the RESTRICT on
  // product_location_stock stand for something real.
  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_location_stock WHERE location_id = ?', [id] as never)
    await tx.execute('DELETE FROM stock_locations WHERE id = ?', [id] as never)
  })

  return { ok: true }
}

export type LocationStock = {
  locationId: number
  code: string
  name: string
  isMain: boolean
  isActive: boolean
  stockOnHand: number
  minStock: number
  maxStock: number
}

/**
 * One product, broken down by location — what the product page shows.
 *
 * LEFT JOIN from locations, not from the piles: a location holding nothing yet
 * still has to appear, with zeroes, or there is nowhere on the screen to type
 * its reorder levels. Inactive locations are included only when they hold
 * something, so a closed room that still has stock in it stays visible rather
 * than hiding the goods.
 */
export async function locationStockFor(
  siteId: number,
  productId: number,
): Promise<LocationStock[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id AS location_id, l.code, l.name, l.is_main, l.is_active,
            COALESCE(pls.stock_on_hand, 0) AS stock_on_hand,
            COALESCE(pls.min_stock, 0)     AS min_stock,
            COALESCE(pls.max_stock, 0)     AS max_stock
       FROM stock_locations l
       LEFT JOIN product_location_stock pls
              ON pls.location_id = l.id AND pls.product_id = ?
      WHERE l.is_active = 1 OR COALESCE(pls.stock_on_hand, 0) <> 0
      ORDER BY l.is_main DESC, l.sort_order ASC, l.code ASC`,
    [productId],
  )

  return rows.map((r) => ({
    locationId: Number(r.location_id),
    code: String(r.code),
    name: String(r.name),
    isMain: !!r.is_main,
    isActive: !!r.is_active,
    stockOnHand: toNum(r.stock_on_hand),
    minStock: toNum(r.min_stock),
    maxStock: toNum(r.max_stock),
  }))
}

/**
 * Checks a pair of reorder levels.
 *
 * Lives here rather than in validateProduct because a level belongs to a
 * (product, location) pair, not to the product. Returns the message rather
 * than throwing, so a caller can surface it against the field the user typed.
 */
export function validateLevels(levels: { minStock: number; maxStock: number }): string | null {
  if (!Number.isFinite(levels.minStock) || levels.minStock < 0) {
    return 'Minimum level cannot be negative.'
  }
  if (!Number.isFinite(levels.maxStock) || levels.maxStock < 0) {
    return 'Maximum level cannot be negative.'
  }
  // Zero max means "no ceiling set", so it is not a violation of min <= max.
  if (levels.maxStock > 0 && levels.minStock > levels.maxStock) {
    return 'Minimum level cannot be above the maximum level.'
  }
  return null
}

/**
 * Saves the reorder levels for one product in one location.
 *
 * Upserts because a location that has never held the product has no row yet,
 * and typing a level into it is a perfectly ordinary thing to do first.
 * stock_on_hand is untouched on the update branch — levels are settings, and
 * only a movement may change a pile.
 *
 * Refuses an invalid pair rather than writing it: these two figures drive the
 * reorder report, and a minimum above the maximum would have it recommend
 * ordering up to less than it just said was too little.
 */
export async function saveLocationLevels(
  siteId: number,
  productId: number,
  locationId: number,
  levels: { minStock: number; maxStock: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const invalid = validateLevels(levels)
  if (invalid) return { ok: false, error: invalid }

  await siteExecute(
    siteId,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
          VALUES (?,?,0,?,?)
     ON DUPLICATE KEY UPDATE min_stock = VALUES(min_stock), max_stock = VALUES(max_stock)`,
    [productId, locationId, levels.minStock.toFixed(3), levels.maxStock.toFixed(3)],
  )
  return { ok: true }
}

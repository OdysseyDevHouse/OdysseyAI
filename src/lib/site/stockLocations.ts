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
  /**
   * The van, not a room: goods dispatched to another store and not yet
   * received. Written only by storeTransfers.ts, and hidden from every picker —
   * nobody sells from a truck, counts one, or transfers into one by hand.
   */
  isTransit: boolean
  isActive: boolean
  address: string | null
  note: string | null
  sortOrder: number
  /**
   * A pile that moves: a technician van.
   *
   * Distinct from isTransit, which is goods on their way to another STORE and is
   * hidden from every picker. A van is the opposite — stock gets there by a
   * hand-made transfer and a van stocktake is a real business need — so it is
   * visible where a human picks a room, and hidden only where it would be wrong
   * (goods received, reorder suggestions). See LOCATION_PURPOSE below.
   */
  isMobile: boolean
  /** Products holding a non-zero pile here. Shown before offering to delete. */
  productCount: number
  /** Movements recorded against it — the history that makes deletion refuseable. */
  movementCount: number
}

/**
 * What a caller is going to do with a list of locations, and therefore whether a
 * technician van belongs in it.
 *
 * A van is a real pile that must appear wherever stock is MOVED or COUNTED — that
 * is how stock gets onto it, and a van stocktake is a real business need. It must
 * NOT appear where goods arrive from outside or where somebody decides what to
 * buy: a supplier does not deliver into a bakkie, and reordering to one would put
 * a purchase order against a vehicle.
 *
 * Named rather than inferred, because the two cases look identical at the call
 * site — both are "a picker of rooms" — and only the caller knows which it is.
 */
export const LOCATION_PURPOSE = {
  /** Moving stock between rooms, and onto a van. */
  transfer: { mobile: true },
  /** Counting a pile, including a van. */
  count: { mobile: true },
  /** Selling. A van is not sellable stock — availableToSell reads MAIN. */
  sell: { mobile: false },
  /** Goods arriving from a supplier. Never into a vehicle. */
  receive: { mobile: false },
  /** Deciding what to buy. A purchase order against a bakkie is nonsense. */
  reorder: { mobile: false },
  /** Writing stock on or off. A van pile can genuinely be adjusted. */
  adjust: { mobile: true },
} as const

export type LocationPurpose = keyof typeof LOCATION_PURPOSE

type Row = RowDataPacket & Record<string, unknown>

function mapLocation(r: Row): StockLocation {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    isMain: !!r.is_main,
    isTransit: !!r.is_transit,
    isMobile: !!r.is_mobile,
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
  SELECT l.id, l.code, l.name, l.is_main, l.is_transit, l.is_mobile, l.is_active, l.address, l.note, l.sort_order,
         (SELECT COUNT(*) FROM product_location_stock pls
           WHERE pls.location_id = l.id AND pls.stock_on_hand <> 0) AS product_count,
         (SELECT COUNT(*) FROM stock_movements m
           WHERE m.location_id = l.id)                              AS movement_count
    FROM stock_locations l
`

/**
 * Every location, newest rules first.
 *
 * `excludeTransit` is what a PICKER wants and what a report does not. The
 * transit location is a real pile with real movements — the reconciliation and
 * the stock valuation must see it, or the figures stop adding up — but nobody
 * sells from a truck, counts one, or transfers into one by hand. So the default
 * is to include it, and every screen that offers a choice passes true.
 */
export async function listLocations(
  siteId: number,
  includeInactive = true,
  excludeTransit = false,
  /**
   * What the caller is going to do with the list.
   *
   * ── WHY THIS IS NOT A THIRD BOOLEAN ────────────────────────────────────
   *
   * `excludeTransit` used to mean "give me somewhere a human can pick", and for
   * two kinds of location a single flag said it. Vans broke that: they must
   * appear where stock is MOVED or COUNTED and must not appear where goods are
   * RECEIVED from a supplier or reordered to — nobody has a delivery dropped into
   * a bakkie, and nobody reorders to one.
   *
   * That is not one boolean, and the signature already carries two positional
   * ones. A third is how a call site ends up passing them in the wrong order, so
   * the distinction is a named purpose instead. Omitted, every existing caller
   * behaves exactly as it did.
   */
  purpose?: LocationPurpose,
): Promise<StockLocation[]> {
  const where: string[] = []
  if (!includeInactive) where.push('l.is_active = 1')
  if (excludeTransit) where.push('l.is_transit = 0')
  if (purpose && !LOCATION_PURPOSE[purpose].mobile) where.push('l.is_mobile = 0')

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LOCATION}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
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

/**
 * The pile that means "on the road", inside a caller's open transaction.
 *
 * A dispatch to another store writes goods here and a receipt takes them out
 * again, so it is resolved on `tx` for the same reason main is: a transfer must
 * not straddle a change to which row carries the flag.
 *
 * Throws rather than returning null. 101_store_transfers.sql seeds one for
 * every site, so reaching this means the migration has not run — and a dispatch
 * that silently invented a location would break invariant (C) with nothing to
 * show for it. Failing loudly beats writing movements nobody can trace.
 */
export async function transitLocationIdTx(tx: PoolConnection): Promise<number> {
  const [rows] = await tx.execute(
    'SELECT id FROM stock_locations WHERE is_transit = 1 ORDER BY id ASC LIMIT 1',
  )
  const row = (rows as Row[])[0]
  if (!row) {
    throw new Error(
      'This site has no in-transit stock location. Run sql/site/101_store_transfers.sql before dispatching to another store.',
    )
  }
  return Number(row.id)
}

/** Same, outside a transaction — for reads and for pre-flight checks. */
export async function transitLocationId(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_locations WHERE is_transit = 1 ORDER BY id ASC LIMIT 1',
  )
  if (!row) {
    throw new Error(
      'This site has no in-transit stock location. Run sql/site/101_store_transfers.sql before dispatching to another store.',
    )
  }
  return Number(row.id)
}

/**
 * Every van.
 *
 * Deliberately NOT a `mobileLocationIdTx()` sibling to mainLocationIdTx and
 * transitLocationIdTx. Those exist because there is exactly ONE such row and every
 * path needs to find it without being told, so both do `ORDER BY id LIMIT 1`.
 *
 * A van is the opposite: there are n of them, and every path that touches one is
 * TOLD which — the technician picks it, or it resolves from the visit assignees.
 * A LIMIT 1 helper would silently issue every part to whichever bakkie has the
 * lowest id, which is the kind of bug that looks like it works.
 */
export async function listVans(siteId: number, includeInactive = false): Promise<StockLocation[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_LOCATION}
      WHERE l.is_mobile = 1 ${includeInactive ? '' : 'AND l.is_active = 1'}
      ORDER BY l.sort_order ASC, l.code ASC`,
  )
  return rows.map(mapLocation)
}

/** Whether this location is a van, inside a caller's transaction. */
export async function isVanTx(tx: PoolConnection, locationId: number): Promise<boolean> {
  const [rows] = await tx.query<Row[]>(
    'SELECT is_mobile FROM stock_locations WHERE id = ? LIMIT 1',
    [locationId],
  )
  return Number(rows[0]?.is_mobile) === 1
}

export type LocationInput = {
  code: string
  name: string
  address?: string | null
  note?: string | null
  isActive?: boolean
  sortOrder?: number
  /**
   * A technician van rather than a room.
   *
   * Optional and defaulting to false, so every existing caller creates exactly
   * what it created before. Deliberately NOT settable on an existing location: a
   * room that has been holding stock for two years does not become a vehicle, and
   * flipping the flag would silently change which pickers the pile appears in and
   * whether it could be the main location. Make a new one.
   */
  isMobile?: boolean
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
  // which is the one place that can clear the incumbent in the same breath — and
  // which refuses a van, for the reason its own comment gives.
  const res = await siteExecute(
    siteId,
    `INSERT INTO stock_locations (code, name, address, note, is_main, is_mobile, is_active, sort_order)
     VALUES (?,?,?,?,0,?,?,?)`,
    [
      code,
      input.name.trim(),
      input.address?.trim() || null,
      input.note?.trim() || null,
      input.isMobile ? 1 : 0,
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

  /*
   * The transit pile is not a setting.
   *
   * It is created by 101_store_transfers.sql and written only by
   * storeTransfers.ts, and deleteLocation() already refuses it for the reason
   * its own comment gives. Editing was the hole left in that: the setup screen
   * hides the button now, but a hidden button is not a boundary and this is the
   * action every path goes through.
   *
   * Deactivating is the one that actually bites. transitLocationIdTx() resolves
   * on is_transit alone and never reads is_active, so a dispatch would keep
   * filling this pile while the row itself dropped out of every active list —
   * goods accumulating somewhere the setup screen says is switched off. A
   * rename is milder but still wrong: this name is what the dispatch and
   * receipt screens call the place, so it is the system's word, not the site's.
   */
  if (existing.isTransit) {
    return {
      ok: false,
      error: `${existing.name} is where goods sit while they travel between stores. It is managed by the system and cannot be edited.`,
    }
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
  /*
   * The main location is where the till sells from. Pointing that at the van
   * would have the counter promise goods that are on a motorway, and would put
   * every unallocated movement — every sale — into a pile that exists only to
   * be emptied by the receiving store.
   */
  if (target.isTransit) {
    return {
      ok: false,
      error: `${target.name} holds goods on their way to another store, so it cannot be the location sales come from.`,
    }
  }
  /*
   * A van, for the reason the comment above already gives about transit — and it
   * gives it in exactly these words: pointing the till at the van would have the
   * counter promise goods that are on a motorway.
   *
   * Worse than misleading. recordMovement() resolves mainLocationIdTx() whenever a
   * caller passes no location, and salesPosting.ts never passes one — so making a
   * bakkie main would route EVERY sale movement in the business into a pile that
   * is driving around.
   */
  if (target.isMobile) {
    return {
      ok: false,
      error: `${target.name} is a vehicle, so it cannot be the location sales come from — the counter would be promising goods that are on the road.`,
    }
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

  /*
   * Refused even when empty. The pile is empty precisely when nothing is on the
   * road, which is most of the time — so the check below would let it be
   * deleted on any quiet afternoon, and the next dispatch would fail on a
   * location the migration created and a user removed.
   */
  if (location.isTransit) {
    return {
      ok: false,
      error: `${location.name} is where goods sit while they travel between stores. It is managed by the system and cannot be deleted.`,
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

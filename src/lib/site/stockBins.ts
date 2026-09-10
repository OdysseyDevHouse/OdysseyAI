import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
/* The cap and the label live in lib/placements.ts, not here: the product screen
   is a Client Component that needs the same two, and this module is server-only.
   Re-exported so server callers still import one thing. */
import { MAX_PLACEMENTS_PER_LOCATION, placementLabel } from '../placements'
export { MAX_PLACEMENTS_PER_LOCATION, placementLabel } from '../placements' 

/**
 * Shelves and bins: WHERE IN THE ROOM a product lives.
 *
 * stockLocations.ts answers "which room" and product_location_stock holds the
 * pile. This is the level under it — a maintained register of shelves per
 * location, bins on those shelves, and a placement saying where each product is
 * kept.
 *
 * ── A PLACEMENT IS A LABEL, NOT A PILE ─────────────────────────────────────
 *
 * Nothing here holds a quantity, and that is the load-bearing decision. The
 * invariants 025_stock_locations.sql set out — Σ movements = the pile, Σ piles =
 * the site total — are untouched, no movement path changes, and there is no
 * fourth figure that can drift. A placement says where to walk. That is all it
 * says, and all it is allowed to say.
 *
 * The consequence worth remembering when extending this: moving a product from
 * one bin to another is an EDIT, not a movement. It writes no history and posts
 * nothing, because nothing about what the business owns has changed.
 *
 * ── WHY A SHELF IS ITS OWN ROW ─────────────────────────────────────────────
 *
 * It would be shorter to give a bin a single code of "A03-2" and call the first
 * half a shelf. That fails the commonest site: a shop with shelving and no
 * numbered slots at all. Those sites still need somewhere to sort a count sheet
 * by, and under the flattened scheme they would have to invent bin numbers to
 * get it. A placement here may name a shelf and no bin, which is a complete
 * answer rather than a half-filled one.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Types ──────────────────────────────────────────────────────────────── */

export type StockBin = {
  id: number
  shelfId: number
  code: string
  name: string | null
  isActive: boolean
  sortOrder: number
  /** Products placed in this bin. Shown before offering to delete it. */
  placementCount: number
}

export type StockShelf = {
  id: number
  locationId: number
  code: string
  name: string
  note: string | null
  isActive: boolean
  sortOrder: number
  /** Products placed on this shelf, in any of its bins or on the shelf itself. */
  placementCount: number
  bins: StockBin[]
}

/**
 * Where one product is kept, in one location.
 *
 * A product may have SEVERAL of these in the same room — a pick face on the shop
 * floor and a bulk pallet in the racking is the ordinary case in any business big
 * enough to want bins at all. Exactly one of them is primary.
 */
export type Placement = {
  locationId: number
  shelfId: number
  shelfCode: string
  shelfName: string
  binId: number | null
  binCode: string | null
  /** What a screen prints: "A03 · 2", or just "A03" on a shelf-only placement. */
  label: string
  /**
   * Where somebody is SENT when they ask where this product is.
   *
   * One per (product, location), held by uq_placement_primary in 254. It is the
   * spot the count sheet sorts by and the product screen leads with; the others
   * are overflow, and they are listed rather than walked to.
   */
  isPrimary: boolean
}

/** The same thing with the codes resolved, as the product screen submits it. */
export type PlacementInput = {
  shelfId: number
  binId: number | null
  isPrimary?: boolean
}



export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }


/* ── Validation ─────────────────────────────────────────────────────────── */

/*
 * Shelf codes follow the location rule exactly — 2 to 24 characters, upper
 * case, letters digits and hyphens. They print on labels and group a count
 * sheet, so they need the same discipline for the same reasons.
 *
 * Bin codes allow a SINGLE character, and that is a deliberate difference
 * rather than an oversight. Bins are numbered 1, 2, 3 up a rack, which is how
 * racking arrives from the factory and how staff already refer to it. Forcing a
 * two-character minimum would have every site typing 01 to satisfy a rule that
 * exists for shelf codes, where a one-letter name really is too little to
 * identify a bay.
 */
const SHELF_CODE = /^[A-Z0-9-]{2,24}$/
const BIN_CODE = /^[A-Z0-9-]{1,24}$/

export function validateShelf(input: { code: string; name: string }): string | null {
  if (!input.code?.trim()) return 'A shelf code is required.'
  if (!SHELF_CODE.test(input.code.trim().toUpperCase())) {
    return 'Shelf code must be 2–24 characters, letters, digits and hyphens only.'
  }
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 120) return 'Name must be 120 characters or fewer.'
  return null
}

export function validateBin(input: { code: string }): string | null {
  if (!input.code?.trim()) return 'A bin code is required.'
  if (!BIN_CODE.test(input.code.trim().toUpperCase())) {
    return 'Bin code must be 1–24 characters, letters, digits and hyphens only.'
  }
  return null
}

/* ── Reading ────────────────────────────────────────────────────────────── */

/*
 * placement_count is a correlated subquery on both tables rather than a join,
 * for the reason SELECT_LOCATION in stockLocations.ts gives: a join would
 * multiply the shelf row by its placements and need a GROUP BY to undo, and
 * these lists are short.
 *
 * The shelf count spans the whole shelf — its bins and the shelf itself — because
 * that is the number that answers "what am I about to disturb by deleting this".
 */
const SELECT_SHELF = `
  SELECT s.id, s.location_id, s.code, s.name, s.note, s.is_active, s.sort_order,
         (SELECT COUNT(*) FROM product_placements pp WHERE pp.shelf_id = s.id) AS placement_count
    FROM stock_shelves s
`

function mapShelf(r: Row, bins: StockBin[]): StockShelf {
  return {
    id: Number(r.id),
    locationId: Number(r.location_id),
    code: String(r.code),
    name: String(r.name),
    note: (r.note as string | null) ?? null,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 0),
    placementCount: Number(r.placement_count ?? 0),
    bins,
  }
}

function mapBin(r: Row): StockBin {
  return {
    id: Number(r.id),
    shelfId: Number(r.shelf_id),
    code: String(r.code),
    name: (r.name as string | null) ?? null,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 0),
    placementCount: Number(r.placement_count ?? 0),
  }
}

/**
 * Every shelf in one location, each carrying its bins.
 *
 * Ordered by sort_order before code, everywhere, because that pair IS the walk
 * order: a site puts its shelves in the sequence somebody actually walks them,
 * and code order is alphabetical, which no room is. The count sheet sorts by
 * exactly the same key, so what this screen shows top to bottom is the order the
 * sheet will be printed in.
 *
 * Two queries rather than one joined read: a shelf with no bins must still come
 * back, and stitching in JS beats a LEFT JOIN whose null rows every caller then
 * has to filter.
 */
export async function listShelves(
  siteId: number,
  locationId: number,
  includeInactive = true,
): Promise<StockShelf[]> {
  const shelfRows = await siteQuery<Row>(
    siteId,
    `${SELECT_SHELF}
      WHERE s.location_id = ? ${includeInactive ? '' : 'AND s.is_active = 1'}
      ORDER BY s.sort_order ASC, s.code ASC`,
    [locationId],
  )
  if (shelfRows.length === 0) return []

  const binRows = await siteQuery<Row>(
    siteId,
    `SELECT b.id, b.shelf_id, b.code, b.name, b.is_active, b.sort_order,
            (SELECT COUNT(*) FROM product_placements pp WHERE pp.bin_id = b.id) AS placement_count
       FROM stock_bins b
       JOIN stock_shelves s ON s.id = b.shelf_id
      WHERE s.location_id = ? ${includeInactive ? '' : 'AND b.is_active = 1'}
      ORDER BY b.sort_order ASC, b.code ASC`,
    [locationId],
  )

  const byShelf = new Map<number, StockBin[]>()
  for (const r of binRows) {
    const bin = mapBin(r)
    const list = byShelf.get(bin.shelfId)
    if (list) list.push(bin)
    else byShelf.set(bin.shelfId, [bin])
  }

  return shelfRows.map((r) => mapShelf(r, byShelf.get(Number(r.id)) ?? []))
}

/**
 * Whether this site has any shelves at all, or any in one location.
 *
 * The switch every screen reads. A site that has never opened the shelves
 * screen must see the product page and the count sheet exactly as they were
 * before this feature existed — no bin column, no picker, nothing to explain —
 * so each of those asks this first rather than rendering an empty control.
 *
 * LIMIT 1 on an indexed column: it is asked on page loads that do not otherwise
 * touch these tables, and the answer is no on most sites.
 */
export async function hasAnyShelves(siteId: number, locationId?: number): Promise<boolean> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT 1 AS found FROM stock_shelves
      ${locationId ? 'WHERE location_id = ?' : ''} LIMIT 1`,
    locationId ? [locationId] : [],
  )
  return row !== null
}

export type ShelfOption = {
  shelfId: number
  code: string
  name: string
  isActive: boolean
  bins: { binId: number; code: string; name: string | null; isActive: boolean }[]
}

/** Every shelf and bin in the site, grouped by the location that owns it. */
export type LocationBinOptions = { locationId: number; shelves: ShelfOption[] }[]

/**
 * The pickers for every location at once — what the product screen needs.
 *
 * One query for the whole site rather than one per location. A product page
 * renders a row per location, and a per-location call would be n round trips to
 * build n dropdowns that are almost always tiny.
 *
 * Inactive shelves and bins ARE returned, flagged rather than filtered. A
 * product already placed on a shelf that has since been switched off must still
 * show where it is; the screen greys those options and refuses to let a new
 * placement pick one.
 */
export async function binOptionsFor(siteId: number): Promise<LocationBinOptions> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id AS shelf_id, s.location_id, s.code AS shelf_code, s.name AS shelf_name,
            s.is_active AS shelf_active,
            b.id AS bin_id, b.code AS bin_code, b.name AS bin_name, b.is_active AS bin_active
       FROM stock_shelves s
       LEFT JOIN stock_bins b ON b.shelf_id = s.id
      ORDER BY s.location_id ASC, s.sort_order ASC, s.code ASC,
               b.sort_order ASC, b.code ASC`,
  )

  /* A plain array rather than a Map keyed by location id, because this crosses
     into a Client Component. Flight can carry a Map, but an array of records is
     unambiguous, survives any serialisation boundary, and reads the same at the
     call site — which is not worth trading for a lookup on a list this short. */
  const out: LocationBinOptions = []
  const byLocation = new Map<number, ShelfOption[]>()
  const shelves = new Map<number, ShelfOption>()

  for (const r of rows) {
    const shelfId = Number(r.shelf_id)
    let shelf = shelves.get(shelfId)
    if (!shelf) {
      shelf = {
        shelfId,
        code: String(r.shelf_code),
        name: String(r.shelf_name),
        isActive: !!r.shelf_active,
        bins: [],
      }
      shelves.set(shelfId, shelf)
      const locationId = Number(r.location_id)
      const list = byLocation.get(locationId)
      if (list) {
        list.push(shelf)
      } else {
        const created = [shelf]
        byLocation.set(locationId, created)
        out.push({ locationId, shelves: created })
      }
    }
    // LEFT JOIN: a shelf with no bins arrives as one row with a null bin.
    if (r.bin_id !== null && r.bin_id !== undefined) {
      shelf.bins.push({
        binId: Number(r.bin_id),
        code: String(r.bin_code),
        name: (r.bin_name as string | null) ?? null,
        isActive: !!r.bin_active,
      })
    }
  }

  return out
}

const SELECT_PLACEMENT = `
  SELECT pp.location_id, pp.shelf_id, pp.bin_id, pp.is_primary,
         s.code AS shelf_code, s.name AS shelf_name, b.code AS bin_code
    FROM product_placements pp
    JOIN stock_shelves s ON s.id = pp.shelf_id
    LEFT JOIN stock_bins b ON b.id = pp.bin_id
`

function mapPlacement(r: Row): Placement {
  const shelfCode = String(r.shelf_code)
  const binCode = (r.bin_code as string | null) ?? null
  return {
    locationId: Number(r.location_id),
    shelfId: Number(r.shelf_id),
    shelfCode,
    shelfName: String(r.shelf_name),
    binId: r.bin_id === null || r.bin_id === undefined ? null : Number(r.bin_id),
    binCode,
    label: placementLabel(shelfCode, binCode),
    isPrimary: !!r.is_primary,
  }
}

/**
 * Every spot this product is kept in, across every room.
 *
 * All of them, not just the primary — a caller that wanted only the primary got
 * the wrong answer the moment overflow bins existed, and "where is it" is a
 * question with more than one answer by design.
 *
 * Ordered primary-first within each location and then along the walk, so a
 * screen can take the head of the list as the place to send somebody and show
 * the rest as also-kept-here without sorting anything itself.
 */
export async function placementsFor(siteId: number, productId: number): Promise<Placement[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_PLACEMENT}
      WHERE pp.product_id = ?
      ORDER BY pp.location_id ASC, pp.is_primary DESC,
               s.sort_order ASC, s.code ASC, b.sort_order ASC, b.code ASC`,
    [productId],
  )
  return rows.map(mapPlacement)
}

/* ── Shelves ────────────────────────────────────────────────────────────── */

export type ShelfInput = {
  code: string
  name: string
  note?: string | null
  isActive?: boolean
  sortOrder?: number
}

export async function createShelf(
  siteId: number,
  locationId: number,
  input: ShelfInput,
): Promise<SaveResult> {
  const invalid = validateShelf(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_shelves WHERE location_id = ? AND code = ? LIMIT 1',
    [locationId, code],
  )
  if (clash) return { ok: false, error: `This location already has a shelf called "${code}".` }

  const res = await siteExecute(
    siteId,
    `INSERT INTO stock_shelves (location_id, code, name, note, is_active, sort_order)
     VALUES (?,?,?,?,?,?)`,
    [
      locationId,
      code,
      input.name.trim(),
      input.note?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? 0,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateShelf(
  siteId: number,
  id: number,
  input: ShelfInput,
): Promise<SaveResult> {
  const invalid = validateShelf(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id, location_id, code, sort_order FROM stock_shelves WHERE id = ? LIMIT 1',
    [id],
  )
  if (!existing) return { ok: false, error: 'Shelf not found.' }

  const code = input.code.trim().toUpperCase()
  if (code !== String(existing.code)) {
    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM stock_shelves WHERE location_id = ? AND code = ? AND id <> ? LIMIT 1',
      [Number(existing.location_id), code, id],
    )
    if (clash) return { ok: false, error: `This location already has a shelf called "${code}".` }
  }

  await siteExecute(
    siteId,
    `UPDATE stock_shelves
        SET code = ?, name = ?, note = ?, is_active = ?, sort_order = ?
      WHERE id = ?`,
    [
      code,
      input.name.trim(),
      input.note?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? Number(existing.sort_order ?? 0),
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * Deletes a shelf, its bins and every placement that named it.
 *
 * Allowed even when products are placed on it, unlike deleting a stock location
 * — and the difference is the point. A location cannot go because movements
 * name it and the stock history would stop adding up. A shelf is named by
 * nothing but labels, so removing one costs the site the knowledge of where
 * those products were kept and nothing else. Re-racking a room is a normal
 * afternoon, and a register that refused to let go of a bay that no longer
 * exists would just be abandoned.
 *
 * The screen still says how many products are about to lose their spot before
 * it offers the button — see placementCount.
 *
 * The DELETEs are explicit rather than left to the cascades on the foreign
 * keys. They do the same thing, but a reader of this function should be able to
 * see what it destroys without going to the schema to find out.
 */
export async function deleteShelf(siteId: number, id: number): Promise<DeleteResult> {
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_shelves WHERE id = ? LIMIT 1',
    [id],
  )
  if (!existing) return { ok: false, error: 'Shelf not found.' }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM product_placements WHERE shelf_id = ?', [id] as never)
    await tx.execute('DELETE FROM stock_bins WHERE shelf_id = ?', [id] as never)
    await tx.execute('DELETE FROM stock_shelves WHERE id = ?', [id] as never)
  })
  return { ok: true }
}

/* ── Bins ───────────────────────────────────────────────────────────────── */

export type BinInput = {
  code: string
  name?: string | null
  isActive?: boolean
  sortOrder?: number
}

export async function createBin(
  siteId: number,
  shelfId: number,
  input: BinInput,
): Promise<SaveResult> {
  const invalid = validateBin(input)
  if (invalid) return { ok: false, error: invalid }

  const shelf = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code FROM stock_shelves WHERE id = ? LIMIT 1',
    [shelfId],
  )
  if (!shelf) return { ok: false, error: 'Shelf not found.' }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_bins WHERE shelf_id = ? AND code = ? LIMIT 1',
    [shelfId, code],
  )
  if (clash) {
    return { ok: false, error: `${String(shelf.code)} already has a bin called "${code}".` }
  }

  const res = await siteExecute(
    siteId,
    'INSERT INTO stock_bins (shelf_id, code, name, is_active, sort_order) VALUES (?,?,?,?,?)',
    [
      shelfId,
      code,
      input.name?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? 0,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateBin(siteId: number, id: number, input: BinInput): Promise<SaveResult> {
  const invalid = validateBin(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT b.id, b.shelf_id, b.code, b.sort_order, s.code AS shelf_code
       FROM stock_bins b JOIN stock_shelves s ON s.id = b.shelf_id
      WHERE b.id = ? LIMIT 1`,
    [id],
  )
  if (!existing) return { ok: false, error: 'Bin not found.' }

  const code = input.code.trim().toUpperCase()
  if (code !== String(existing.code)) {
    const clash = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM stock_bins WHERE shelf_id = ? AND code = ? AND id <> ? LIMIT 1',
      [Number(existing.shelf_id), code, id],
    )
    if (clash) {
      return {
        ok: false,
        error: `${String(existing.shelf_code)} already has a bin called "${code}".`,
      }
    }
  }

  await siteExecute(
    siteId,
    'UPDATE stock_bins SET code = ?, name = ?, is_active = ?, sort_order = ? WHERE id = ?',
    [
      code,
      input.name?.trim() || null,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? Number(existing.sort_order ?? 0),
      id,
    ],
  )
  return { ok: true, id }
}

/**
 * Deletes a bin. Anything placed in it falls back to the SHELF.
 *
 * Falling back rather than being unplaced is the whole reason this does not
 * simply let the foreign key cascade. A bin that gets renumbered or removed does
 * not mean nobody knows where the goods are — they are still on A03, which is
 * most of the answer and the part that gets somebody to the right aisle.
 *
 * ── THE COLLISION ──────────────────────────────────────────────────────────
 *
 * Clearing bin_id can run into a placement that is ALREADY shelf-only for the
 * same product and shelf, which uq_placement refuses — two rows would then be
 * (product, location, shelf, no bin). One of the pair has to go.
 *
 * The primary is always the survivor, and it always can be: only one row per
 * (product, location) may carry is_primary, so a colliding pair is by
 * construction exactly one primary and one overflow. Dropping the overflow can
 * therefore never leave a product with a location it has no primary placement
 * in — which would make it vanish from the product screen and the count sheet.
 */
export async function deleteBin(siteId: number, id: number): Promise<DeleteResult> {
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_bins WHERE id = ? LIMIT 1',
    [id],
  )
  if (!existing) return { ok: false, error: 'Bin not found.' }

  await siteTransaction(siteId, async (tx) => {
    // The overflow half of any pair that would collide once the bin is cleared.
    // Written both ways round because either row of the pair may be the one
    // naming this bin.
    await tx.execute(
      `DELETE p FROM product_placements p
         JOIN product_placements q
           ON q.product_id = p.product_id
          AND q.location_id = p.location_id
          AND q.shelf_id    = p.shelf_id
          AND q.id <> p.id
        WHERE p.is_primary = 0
          AND ((p.bin_id = ? AND q.bin_id IS NULL) OR (p.bin_id IS NULL AND q.bin_id = ?))`,
      [id, id] as never,
    )
    await tx.execute('UPDATE product_placements SET bin_id = NULL WHERE bin_id = ?', [id] as never)
    await tx.execute('DELETE FROM stock_bins WHERE id = ?', [id] as never)
  })
  return { ok: true }
}

/* ── Walk order ─────────────────────────────────────────────────────────── */

/**
 * Saves the order somebody walks the room in.
 *
 * This is the setting the whole feature turns on. buildSheetLines sorts a count
 * sheet by sort_order before code, so dragging these rows into the sequence the
 * aisles are actually walked is what makes a printed sheet follow a route rather
 * than the alphabet.
 *
 * One statement per row, mirroring reorderTenderTypes(): the lists are a handful
 * of rows reordered rarely, and a CASE expression over n ids would be harder to
 * read for no measurable gain.
 *
 * Positions start at 1 so that 0 keeps meaning "never ordered" — a shelf added
 * later and not yet dragged sorts to the top, where it is noticed, rather than
 * disappearing into the middle of an established route.
 */
export async function reorderShelves(siteId: number, orderedIds: number[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE stock_shelves SET sort_order = ? WHERE id = ?', [
      index + 1,
      id,
    ])
  }
}

export async function reorderBins(siteId: number, orderedIds: number[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await siteExecute(siteId, 'UPDATE stock_bins SET sort_order = ? WHERE id = ?', [index + 1, id])
  }
}

/* ── Placing a product ──────────────────────────────────────────────────── */

/**
 * Sets every spot one product is kept in, in one location.
 *
 * ── REPLACES THE WHOLE SET ─────────────────────────────────────────────────
 *
 * The list submitted is the complete intended answer for that room, so anything
 * absent from it is removed. Same contract as the instruction groups and kitchen
 * printers on the product form, and the same reason: a screen that shows all of
 * something and saves only additions can never be used to take one away.
 *
 * An empty list means "not kept anywhere in this room" and deletes the rows
 * rather than storing an empty placement. There is no such thing as being placed
 * nowhere, and a row saying so would turn up in every count of what a shelf holds.
 *
 * ── EXACTLY ONE PRIMARY ────────────────────────────────────────────────────
 *
 * uq_placement_primary in 254 refuses a second, so a caller that marked two
 * would get a duplicate-key error naming a constraint instead of a sentence.
 * The first entry is promoted when nobody is marked, which is what a form that
 * lists the primary first already means.
 *
 * ── DELETE THEN INSERT ─────────────────────────────────────────────────────
 *
 * Rather than diffing. Placements are labels with no history hanging off them —
 * nothing references a placement row by id — so replacing them wholesale cannot
 * lose anything, and a diff would have to reason about three unique keys at once
 * to work out which of an upsert branch to take.
 */
export async function setPlacements(
  siteId: number,
  productId: number,
  locationId: number,
  placements: readonly PlacementInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  /* Deduped on the pair that uq_placement makes unique, so a form that offers
     the same bin twice is a no-op rather than a duplicate-key error. The first
     of a pair wins, which keeps a primary marked earlier in the list. */
  const seen = new Set<string>()
  const wanted: PlacementInput[] = []
  for (const p of placements) {
    if (!Number.isFinite(p.shelfId) || p.shelfId <= 0) continue
    const key = `${p.shelfId}:${p.binId ?? 0}`
    if (seen.has(key)) continue
    seen.add(key)
    wanted.push({ shelfId: p.shelfId, binId: p.binId ?? null, isPrimary: p.isPrimary === true })
  }

  if (wanted.length > MAX_PLACEMENTS_PER_LOCATION) {
    return {
      ok: false,
      error: `A product can be kept in at most ${MAX_PLACEMENTS_PER_LOCATION} places in one location.`,
    }
  }

  if (wanted.length === 0) {
    await siteExecute(
      siteId,
      'DELETE FROM product_placements WHERE product_id = ? AND location_id = ?',
      [productId, locationId],
    )
    return { ok: true }
  }

  /*
   * Every shelf and bin checked against the location before anything is written,
   * even though the composite foreign keys in 254 refuse both mistakes anyway.
   * The point is the message: a constraint name surfaced to somebody editing a
   * product tells them nothing, and this is the one path a wrong pairing can
   * arrive by — a stale dropdown submitted after the shelf was moved or deleted.
   *
   * One query for the lot rather than two per row: this runs inside a product
   * save that may touch every location the site has.
   */
  const shelfIds = [...new Set(wanted.map((p) => p.shelfId))]
  const shelfRows = await siteQuery<Row>(
    siteId,
    `SELECT id, code, location_id FROM stock_shelves
      WHERE id IN (${shelfIds.map(() => '?').join(',')})`,
    shelfIds,
  )
  const shelvesById = new Map(shelfRows.map((r) => [Number(r.id), r]))

  for (const id of shelfIds) {
    const shelf = shelvesById.get(id)
    if (!shelf) return { ok: false, error: 'One of those shelves no longer exists.' }
    if (Number(shelf.location_id) !== locationId) {
      return {
        ok: false,
        error: `Shelf ${String(shelf.code)} is in another location, so nothing can be placed on it here.`,
      }
    }
  }

  const binIds = wanted.map((p) => p.binId).filter((id): id is number => id !== null)
  if (binIds.length > 0) {
    const binRows = await siteQuery<Row>(
      siteId,
      `SELECT id, code, shelf_id FROM stock_bins
        WHERE id IN (${binIds.map(() => '?').join(',')})`,
      binIds,
    )
    const binsById = new Map(binRows.map((r) => [Number(r.id), r]))
    for (const p of wanted) {
      if (p.binId === null) continue
      const bin = binsById.get(p.binId)
      if (!bin) return { ok: false, error: 'One of those bins no longer exists.' }
      if (Number(bin.shelf_id) !== p.shelfId) {
        const shelf = shelvesById.get(p.shelfId)
        return {
          ok: false,
          error: `Bin ${String(bin.code)} is not on shelf ${String(shelf?.code ?? p.shelfId)}.`,
        }
      }
    }
  }

  // Exactly one, whatever was asked for. See the header.
  const primaryAt = Math.max(
    0,
    wanted.findIndex((p) => p.isPrimary),
  )

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      'DELETE FROM product_placements WHERE product_id = ? AND location_id = ?',
      [productId, locationId] as never,
    )
    for (const [i, p] of wanted.entries()) {
      await tx.execute(
        `INSERT INTO product_placements (product_id, location_id, shelf_id, bin_id, is_primary)
         VALUES (?,?,?,?,?)`,
        [productId, locationId, p.shelfId, p.binId, i === primaryAt ? 1 : 0] as never,
      )
    }
  })

  return { ok: true }
}

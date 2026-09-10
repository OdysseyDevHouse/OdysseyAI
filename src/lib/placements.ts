/**
 * The rules for WHERE a product is kept, shared by the screen and the server.
 *
 * ── WHY THIS IS NOT IN stockBins.ts ────────────────────────────────────────
 *
 * That module is server-only because it talks to the database. But the product
 * screen is a Client Component that has to PRODUCE exactly what the save action
 * PARSES — a spot is carried through the form as one string, "12" for a shelf and
 * "12:34" for a bin on it — and the cap on how many spots a room may hold has to
 * be the same number on both sides or the screen will happily build a list the
 * server then refuses.
 *
 * Duplicating either of those on the client is how the screen and the writer end
 * up disagreeing. lib/tenderMath.ts exists for the same reason and says so at
 * greater length.
 *
 * Nothing here touches the database, so it is safe in either environment.
 */

/**
 * How many spots one product may have in one room.
 *
 * Not a business rule so much as a guard on a form that repeats a field: a
 * product kept in twelve different places in one room is a filing problem rather
 * than a placement, and the cap stops a malformed submission writing hundreds of
 * rows. The screen stops offering "add another" here; setPlacements refuses past
 * it, and that refusal is the boundary.
 */
export const MAX_PLACEMENTS_PER_LOCATION = 12

/** One spot: a shelf, and optionally a bin on it. */
export type Spot = { shelfId: number; binId: number | null }

/**
 * How a placement reads to a human.
 *
 * A middle dot rather than a hyphen or a slash: shelf codes very often contain
 * hyphens already (A-03), and "A-03-2" gives no clue which part is the shelf.
 */
export function placementLabel(shelfCode: string, binCode: string | null): string {
  return binCode ? `${shelfCode} · ${binCode}` : shelfCode
}

/**
 * A spot as one form value.
 *
 * Both levels in a single field because shelf-or-bin is a single choice to the
 * person making it — see PlacementModal for why it is not two chained dropdowns.
 * The shelf id alone means "on this shelf, no particular slot", which is a
 * complete answer and not a half-filled one.
 */
export function spotValue(spot: Spot): string {
  return spot.binId == null ? String(spot.shelfId) : `${spot.shelfId}:${spot.binId}`
}

/**
 * The shape the next-spot rules need from a room.
 *
 * Structural rather than imported from lib/site/stockBins.ts, which is
 * server-only. Anything with these fields satisfies it, including that module's
 * ShelfOption — so the rules stay usable from the screen without dragging a
 * database module into the client bundle.
 */
export type ShelfShape = {
  shelfId: number
  isActive: boolean
  bins: { binId: number; isActive: boolean }[]
}

/**
 * Every spot a room offers, in walk order.
 *
 * The shelf ITSELF comes before its bins, because "anywhere on A03" is a
 * complete answer and not a fallback — plenty of shelving has no numbered slots
 * at all.
 *
 * Switched-off shelves and bins are left out: this is the list of places
 * something may be PUT, and a bay that is out of action is not one of them. A
 * product already sitting on a switched-off shelf is a separate matter, and the
 * picker keeps showing that.
 */
export function candidateSpots(shelves: readonly ShelfShape[]): Spot[] {
  const out: Spot[] = []
  for (const shelf of shelves) {
    if (!shelf.isActive) continue
    out.push({ shelfId: shelf.shelfId, binId: null })
    for (const bin of shelf.bins) {
      if (!bin.isActive) continue
      out.push({ shelfId: shelf.shelfId, binId: bin.binId })
    }
  }
  return out
}

/**
 * What "add another spot" should propose, or null when the room is exhausted.
 *
 * ── WHY THIS IS NOT JUST THE FIRST SHELF ───────────────────────────────────
 *
 * It was, and that was a bug with no symptom: proposing a spot the product
 * already occupied got collapsed as a duplicate, the list came back unchanged,
 * and the button looked broken. Anything offered here must be somewhere the
 * product is not already kept, or adding it cannot be seen.
 *
 * A shelf the product is not on yet wins over another slot on one it already
 * occupies, because the reason to want a second spot is nearly always a bulk bay
 * elsewhere — offering "bin 1" next to the existing "bin 2" is usually not it.
 * Falling back to any free slot keeps the button working once every shelf is in
 * use, and null is the honest answer when nothing is left.
 */
export function nextFreeSpot(
  shelves: readonly ShelfShape[],
  taken: readonly Spot[],
): Spot | null {
  const used = new Set(taken.map(spotValue))
  const free = candidateSpots(shelves).filter((spot) => !used.has(spotValue(spot)))
  if (free.length === 0) return null

  const usedShelves = new Set(taken.map((s) => s.shelfId))
  return free.find((spot) => !usedShelves.has(spot.shelfId)) ?? free[0]
}

/**
 * The inverse, tolerant of anything a stale or hand-made submission can hold.
 *
 * Returns null rather than throwing on junk: this parses form input, where a
 * value that makes no sense should drop the one spot rather than fail a product
 * save that has otherwise succeeded. A zero or negative id is treated as junk
 * too — ids are AUTO_INCREMENT and start at 1, so those can only come from a
 * malformed field.
 */
export function parseSpot(raw: string): Spot | null {
  const [shelfRaw, binRaw] = String(raw ?? '')
    .trim()
    .split(':')
  const shelfId = Number(shelfRaw)
  if (!Number.isFinite(shelfId) || shelfId <= 0) return null

  const binId = binRaw === undefined ? null : Number(binRaw)
  return {
    shelfId,
    binId: binId !== null && Number.isFinite(binId) && binId > 0 ? binId : null,
  }
}

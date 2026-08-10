/**
 * Scheduled price changes, as a till sees them.
 *
 * ── WHY THIS FILE HAS NO `server-only` ───────────────────────────────────
 *
 * Deliberately pure, exactly like specialsEngine.ts and for exactly the same
 * reason. A till holds its catalogue in IndexedDB and may be off the network
 * for hours; if "has the six o'clock price arrived" were a server question,
 * a shop with a dead line would sell at yesterday's prices all morning.
 *
 * So the schedules ship to the till WHOLE, with their moments unevaluated, and
 * the till decides against its own clock. The back office imports the same
 * functions to preview what a till would charge, and the tests run them with no
 * database at all.
 *
 * ── THE PRICE IS ABSOLUTE, NEVER A DELTA ─────────────────────────────────
 *
 * This is the invariant the whole feature rests on. At 06:00 the till resolves
 * to the scheduled price; minutes later the cron writes that same number into
 * product_prices; the till reloads and now reads it as the base price with no
 * schedule pending. Both sides of that write produce the same number, so the
 * price never flickers and never double-applies.
 *
 * Held as '+2.00' instead, the moment the base became 12 every till would
 * resolve 14 until its next refresh — and the ones still offline would stay
 * there.
 */

/** One product's new price under one price type. */
export type PendingPrice = {
  productId: number
  priceStructureId: number
  /** Absolute, VAT-inclusive. See the note above on why this is not a delta. */
  newPriceIncl: number
}

/** A scheduled change as a till holds it: a moment plus what it does. */
export type PendingSchedule = {
  id: number
  name: string
  /** Local wall-clock text, 'YYYY-MM-DDTHH:mm'. */
  effectiveAt: string
  lines: PendingPrice[]
}

/* ── Time ─────────────────────────────────────────────────────────────────── */

/**
 * Parse 'YYYY-MM-DDTHH:mm' as LOCAL time.
 *
 * `new Date(string)` treats a bare date as UTC, which in South Africa would
 * bring a six o'clock price change in at eight. Same function, same reasoning,
 * as parseLocal in specialsEngine.ts — duplicated rather than shared because
 * that one is private to the specials engine and a price change must not break
 * if it ever changes shape.
 */
export function parseLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value ?? '')
  if (!m) return null
  const [, y, mo, d, h, min] = m
  const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min))
  /*
   * Existence check, not just shape. '2026-02-31T06:00' matches the pattern and
   * is not a day — JS rolls it forward to 2 March, so a price nobody scheduled
   * would land two days late. Comparing the parts back rejects it.
   */
  if (parsed.getFullYear() !== Number(y)) return null
  if (parsed.getMonth() !== Number(mo) - 1) return null
  if (parsed.getDate() !== Number(d)) return null
  if (parsed.getHours() !== Number(h)) return null
  if (parsed.getMinutes() !== Number(min)) return null
  return parsed
}

/**
 * Has this schedule's moment arrived?
 *
 * ── LATE IS FINE; EARLY IS NOT ───────────────────────────────────────────
 *
 * Inclusive at the moment itself and true forever after, so a till that was
 * switched off at six and turned on at nine applies the change immediately
 * rather than deciding it missed it. A schedule whose moment has not come is
 * carried unevaluated and does nothing.
 *
 * A malformed or empty moment is never due. A price that fires at a time nobody
 * chose is worse than one that does not fire at all — the shop would find out
 * from a customer.
 */
export function scheduleDueAt(schedule: Pick<PendingSchedule, 'effectiveAt'>, now: Date): boolean {
  const at = parseLocal(schedule.effectiveAt)
  return at !== null && now.getTime() >= at.getTime()
}

/* ── Resolving a price ────────────────────────────────────────────────────── */

const keyOf = (productId: number, priceStructureId: number) => `${productId}:${priceStructureId}`

/**
 * Every price that is in force right now, as a lookup.
 *
 * ── WHY AN INDEX AND NOT A SEARCH ────────────────────────────────────────
 *
 * A whole-catalogue change carries 40 000 lines and a busy basket has twenty,
 * recomputed on every keystroke. Scanning would be the better part of a million
 * comparisons per character typed. Built once per clock tick instead, and the
 * caller memoises it on [schedules, clock].
 *
 * ── WHY THE LAST DUE SCHEDULE WINS ───────────────────────────────────────
 *
 * Two can be due at once: this morning's, and one from last week that failed
 * and is still armed. Ordering by moment and letting the later one land is the
 * only rule that agrees with what the database will hold once the tick catches
 * up — the tick applies them in that same order, so the last one written wins
 * there too. Ties break on id, for the same reason.
 */
export function pendingPriceIndex(
  schedules: readonly PendingSchedule[],
  now: Date,
): Map<string, number> {
  const due = schedules
    .filter((s) => scheduleDueAt(s, now))
    .sort((a, b) => (a.effectiveAt === b.effectiveAt ? a.id - b.id : a.effectiveAt < b.effectiveAt ? -1 : 1))

  const index = new Map<string, number>()
  for (const schedule of due) {
    for (const line of schedule.lines) {
      index.set(keyOf(line.productId, line.priceStructureId), line.newPriceIncl)
    }
  }
  return index
}

/**
 * The scheduled price for one product, or null if nothing is due for it.
 *
 * Null rather than the base price, so a caller can tell "no change" from "a
 * change that happens to match" — the till shows a marker for the first and not
 * the second.
 *
 * For more than a line or two, build a `pendingPriceIndex` once instead.
 */
export function pendingPriceFor(
  productId: number,
  priceStructureId: number | null,
  schedules: readonly PendingSchedule[],
  now: Date,
): number | null {
  // No price type means no price to change — a line with no structure resolved
  // is priced by hand, and there is nothing here to apply to it.
  if (priceStructureId === null) return null
  const found = pendingPriceIndex(schedules, now).get(keyOf(productId, priceStructureId))
  return found === undefined ? null : found
}

/**
 * What this product should be selling at, right now.
 *
 * The base price unless a due schedule replaces it. This is the one function
 * every price display and every basket line goes through, so that a tile and
 * the line it creates cannot disagree.
 */
export function resolvedPriceIncl(
  product: { id: number; priceIncl: number },
  priceStructureId: number | null,
  schedules: readonly PendingSchedule[],
  now: Date,
): number {
  const pending = pendingPriceFor(product.id, priceStructureId, schedules, now)
  return pending === null ? product.priceIncl : pending
}

/**
 * The same lookup against an index built earlier.
 *
 * The hot path: `resolvedPriceIncl` rebuilds the index on every call, which is
 * right for one product and wrong for a screen full of them.
 */
export function resolvedFromIndex(
  product: { id: number; priceIncl: number },
  priceStructureId: number | null,
  index: Map<string, number>,
): number {
  if (priceStructureId === null) return product.priceIncl
  const found = index.get(keyOf(product.id, priceStructureId))
  return found === undefined ? product.priceIncl : found
}

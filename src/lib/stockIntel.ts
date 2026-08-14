/**
 * Stock intelligence — the pure math under /reports/stock-intel.
 *
 * No database imports: everything here takes plain rows and returns plain
 * answers, so the test suite can prove the arithmetic without a fixture in
 * sight, and the report code stays a set of queries feeding a set of sums.
 */

/* ── Age layers ──────────────────────────────────────────────────────────── */

export type AgeBandKey = 'b30' | 'b60' | 'b90' | 'b180' | 'b365' | 'older' | 'unknown'

export type AgeBand = {
  key: AgeBandKey
  label: string
  /** Inclusive upper edge in days; null = no upper edge. */
  maxDays: number | null
}

/**
 * Shared edges. The `ageBand` field in the report-builder catalogue states the
 * same boundaries in SQL — if these change, that CASE expression must follow.
 */
export const AGE_BANDS: AgeBand[] = [
  { key: 'b30', label: '0–30 days', maxDays: 30 },
  { key: 'b60', label: '31–60 days', maxDays: 60 },
  { key: 'b90', label: '61–90 days', maxDays: 90 },
  { key: 'b180', label: '91–180 days', maxDays: 180 },
  { key: 'b365', label: '181–365 days', maxDays: 365 },
  { key: 'older', label: 'Over a year', maxDays: null },
]

export function bandFor(days: number | null): AgeBandKey {
  if (days === null || days < 0 || Number.isNaN(days)) return 'unknown'
  for (const band of AGE_BANDS) {
    if (band.maxDays !== null && days <= band.maxDays) return band.key
  }
  return 'older'
}

export type Arrival = {
  /** ISO date the stock arrived. */
  date: string
  qty: number
  unitCost: number
}

export type AgeLayer = {
  qty: number
  unitCost: number
  /** null when the pile exceeds every recorded arrival — age unknowable. */
  receivedOn: string | null
  days: number | null
}

const DAY_MS = 86_400_000

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS))
}

/**
 * Peels the current pile into age layers, NEWEST arrival first.
 *
 * The FIFO assumption in reverse: whatever is on the shelf now is presumed to
 * be the most recent stock to arrive, because the older stock is what already
 * sold. A pile of 10 against arrivals of [6 yesterday, 8 last year] is 6 units
 * a day old and 4 units a year old — not 10 units at some blended age, which
 * is how an average hides a dead layer under one fresh delivery.
 *
 * Stock beyond every recorded arrival (history predates the movement log)
 * lands in a final layer with no date rather than being dropped or guessed:
 * unknown age is a fact worth reporting, not a gap to paper over.
 */
export function ageLayers(onHand: number, arrivalsNewestFirst: Arrival[], asAtIso: string): AgeLayer[] {
  const layers: AgeLayer[] = []
  let remaining = onHand
  for (const arrival of arrivalsNewestFirst) {
    if (remaining <= 0) break
    if (arrival.qty <= 0) continue
    const take = Math.min(remaining, arrival.qty)
    layers.push({
      qty: take,
      unitCost: arrival.unitCost,
      receivedOn: arrival.date,
      days: daysBetween(arrival.date, asAtIso),
    })
    remaining -= take
  }
  if (remaining > 0) {
    layers.push({ qty: remaining, unitCost: arrivalsNewestFirst.at(-1)?.unitCost ?? 0, receivedOn: null, days: null })
  }
  return layers
}

/* ── ABC classification ──────────────────────────────────────────────────── */

export type AbcClass = 'A' | 'B' | 'C'

/**
 * Classic 80/95 Pareto cut on cumulative share of value, ranked descending:
 * the products that together make the first 80% are A, the next 15% are B,
 * the long tail is C. A product with no value at all is C outright — it
 * contributed nothing, whatever the cumulative line was doing when it passed.
 */
export function classifyAbc<Id>(items: { id: Id; value: number }[]): Map<Id, AbcClass> {
  const ranked = [...items].sort((a, b) => b.value - a.value)
  const total = ranked.reduce((sum, i) => sum + Math.max(0, i.value), 0)
  const out = new Map<Id, AbcClass>()
  let running = 0
  for (const item of ranked) {
    if (item.value <= 0 || total <= 0) {
      out.set(item.id, 'C')
      continue
    }
    running += item.value
    const share = running / total
    out.set(item.id, share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C')
  }
  // The first product alone can exceed 80% — it is still the A of the file.
  if (ranked.length > 0 && ranked[0].value > 0) out.set(ranked[0].id, 'A')
  return out
}

/* ── Stock turn ──────────────────────────────────────────────────────────── */

/**
 * Annualised stock turn: cost of goods sold over the window, scaled to a
 * year, against the value of stock held. Null when nothing is held — a turn
 * of a zero shelf is not infinity, it is a question that does not apply.
 */
export function stockTurn(cogs: number, stockValue: number, windowDays: number): number | null {
  if (stockValue <= 0 || windowDays <= 0) return null
  return (cogs * (365 / windowDays)) / stockValue
}

/** How many days the current shelf lasts at the window's rate of sale. */
export function daysOfStock(cogs: number, stockValue: number, windowDays: number): number | null {
  if (cogs <= 0 || windowDays <= 0) return null
  return stockValue / (cogs / windowDays)
}

/* ── Sell-through ────────────────────────────────────────────────────────── */

/**
 * The share of available stock that sold: sold ÷ (sold + still on hand).
 *
 * Measured against what IS, not against what was received in the window —
 * a shop with deep pre-existing stock and no recent deliveries still needs
 * the number, and "sold ÷ received" divides by zero exactly there.
 */
export function sellThrough(unitsSold: number, unitsOnHand: number): number | null {
  const available = unitsSold + unitsOnHand
  if (available <= 0) return null
  return Math.max(0, unitsSold) / available
}

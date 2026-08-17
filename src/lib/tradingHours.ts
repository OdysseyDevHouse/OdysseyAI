import { parseHm, formatHm, type OpeningHours } from './reservationTypes'

/**
 * Whether a shop is open, and when it could have an order ready.
 *
 * Pure, and kept apart from the database for the same reason reservationTypes
 * is: the storefront decides this on the server before the first paint, and the
 * checkout has to show the same answer in the browser. Two implementations
 * would eventually disagree, and the one the shopper saw would be the one that
 * was wrong.
 *
 * ── THREE STATES, NOT TWO ───────────────────────────────────────────────────
 *
 *   open       inside a trading window, and taking orders
 *   closed     outside it — NOT an error. "Order for tomorrow at 08:15" is the
 *              normal path at 22:30 and the shop still wants that trade.
 *   paused     staff have stopped the queue. A hard stop whatever the clock
 *              says: the fryer is broken, the kitchen is drowning.
 */

export type TradingException = {
  /** ISO date, `YYYY-MM-DD`. */
  onDate: string
  isClosed: boolean
  /** `HH:MM`, or null when closed all day. */
  openTime: string | null
  closeTime: string | null
  note: string
}

export type TradingRules = {
  /**
   * The regular week, or null for "always open" — which is every shop that has
   * never set any, and must stay that way.
   */
  hours: OpeningHours | null
  exceptions: TradingException[]
  acceptingOrders: boolean
  acceptingNote: string
  /** Minutes the shop needs before an order can be collected. */
  leadTimeMinutes: number
  /** How many days ahead an order-for-later may be placed. */
  horizonDays: number
}

export type OpenState =
  | { state: 'open'; closesAt: string | null; note: '' }
  | { state: 'closed'; opensAt: Date | null; note: string }
  | { state: 'paused'; note: string }

/** `YYYY-MM-DD` in the server's own clock. See the note on timezones below. */
export function isoDate(at: Date): string {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const minutesInto = (at: Date) => at.getHours() * 60 + at.getMinutes()

/**
 * The ranges a shop trades on one date, in minutes from midnight.
 *
 * An exception REPLACES the weekly pattern rather than adding to it — a shop
 * open 08:00–13:00 on Christmas Eve is open exactly that, not that plus its
 * usual Tuesday. Returns [] for a closed day.
 */
export function rangesOn(rules: TradingRules, at: Date): [number, number][] {
  const exception = rules.exceptions.find((e) => e.onDate === isoDate(at))
  if (exception) {
    if (exception.isClosed) return []
    const from = exception.openTime ? parseHm(exception.openTime) : null
    const to = exception.closeTime ? parseHm(exception.closeTime) : null
    // A short day with no times is meaningless; treated as closed rather than
    // as "open forever", which is the safer of the two readings.
    return from !== null && to !== null && to > from ? [[from, to]] : []
  }

  // No hours set at all: always open, which is what every shop has had.
  if (rules.hours === null) return [[0, 24 * 60]]

  const today = rules.hours[String(at.getDay())] ?? []
  const out: [number, number][] = []
  for (const [from, to] of today) {
    const a = parseHm(from)
    const b = parseHm(to)
    if (a !== null && b !== null && b > a) out.push([a, b])
  }
  return out.sort((x, y) => x[0] - y[0])
}

/**
 * Open, closed or paused, right now.
 *
 * ── ON CLOCKS ───────────────────────────────────────────────────────────────
 *
 * The SERVER's clock throughout, exactly as the storefront's announcement strip
 * already does. South Africa has no daylight saving, so this is unambiguous —
 * and it stops a shopper whose phone is set to UTC being told a shop is closed
 * when its lights are on.
 */
export function openState(rules: TradingRules, now: Date): OpenState {
  if (!rules.acceptingOrders) {
    return { state: 'paused', note: rules.acceptingNote }
  }

  const ranges = rangesOn(rules, now)
  const mins = minutesInto(now)
  const current = ranges.find(([from, to]) => mins >= from && mins < to)
  if (current) {
    return {
      state: 'open',
      // Null when the shop has no hours at all — there is no closing time to
      // promise, and inventing "closes at midnight" would be a lie.
      closesAt: rules.hours === null ? null : formatHm(current[1]),
      note: '',
    }
  }

  const exception = rules.exceptions.find((e) => e.onDate === isoDate(now))
  return {
    state: 'closed',
    opensAt: nextOpening(rules, now),
    note: exception?.note ?? '',
  }
}

/** The next moment the shop is open, or null if it is not within the horizon. */
export function nextOpening(rules: TradingRules, now: Date): Date | null {
  for (let day = 0; day <= Math.max(1, rules.horizonDays) + 7; day++) {
    const probe = new Date(now)
    probe.setDate(probe.getDate() + day)
    const floor = day === 0 ? minutesInto(now) : 0
    for (const [from, to] of rangesOn(rules, probe)) {
      if (to <= floor) continue
      const at = new Date(probe)
      at.setHours(0, Math.max(from, floor), 0, 0)
      return at
    }
  }
  return null
}

/**
 * Times a shopper could collect, soonest first.
 *
 * ── WHY THE SHOP'S LEAD TIME BOUNDS BOTH ENDS ───────────────────────────────
 *
 * The first slot is now plus the lead time, rounded up — a kitchen needing
 * twenty minutes cannot have an order ready in five. The LAST slot of each
 * window is the lead time BEFORE closing, which is the half people forget: a
 * shop that shuts at 21:00 and needs twenty minutes cannot promise 20:55.
 *
 * Generated on the server and handed to the browser, never computed there. A
 * device with a wrong clock would otherwise offer a slot the kitchen has never
 * heard of, and the shopper would be the last to find out.
 */
export function collectionSlots(
  rules: TradingRules,
  now: Date,
  stepMinutes = 15,
  limit = 96,
): Date[] {
  /*
   * A paused shop offers nothing, whatever its hours say.
   *
   * Checked here and not only in openState, because this function is what the
   * checkout builds its time picker from. Without it, staff could stop the
   * queue and the shop would carry on promising collection times it had already
   * decided it could not keep.
   */
  if (!rules.acceptingOrders) return []

  const step = Math.max(5, stepMinutes)
  const lead = Math.max(0, rules.leadTimeMinutes)
  const earliest = new Date(now.getTime() + lead * 60000)
  const out: Date[] = []

  for (let day = 0; day <= Math.max(0, rules.horizonDays) && out.length < limit; day++) {
    const probe = new Date(now)
    probe.setDate(probe.getDate() + day)

    for (const [from, to] of rangesOn(rules, probe)) {
      // The kitchen must still have time to make it before the doors close.
      const last = to - lead
      for (let m = Math.ceil(from / step) * step; m <= last && out.length < limit; m += step) {
        const at = new Date(probe)
        at.setHours(0, m, 0, 0)
        if (at >= earliest) out.push(at)
      }
    }
  }

  return out
}

/** "today", "tomorrow", or a weekday — how a person says which day. */
export function dayLabel(at: Date, now: Date): string {
  const days = Math.round(
    (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86400000,
  )
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return at.toLocaleDateString('en-ZA', { weekday: 'long' })
}

/** "today at 19:40" — the whole promise in one phrase. */
export function slotLabel(at: Date, now: Date): string {
  return `${dayLabel(at, now)} at ${formatHm(at.getHours() * 60 + at.getMinutes())}`
}

/**
 * Whether a slot a browser sent back is one this shop would actually offer.
 *
 * The delivery fee is already re-quoted server-side rather than trusted; a
 * collection time is the same kind of claim. A stale tab whose shop has since
 * closed early must be refused, not honoured.
 *
 * Compared to the minute, because the generated slots are exact.
 */
export function isOfferedSlot(rules: TradingRules, at: Date, now: Date, stepMinutes = 15): boolean {
  return collectionSlots(rules, now, stepMinutes, 500).some((s) => s.getTime() === at.getTime())
}

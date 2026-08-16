import type { BasketLine } from './basket'

/**
 * What has happened to a basket line SINCE THE TAB WAS OPENED.
 *
 * ── WHY A TILL NEEDS THIS ─────────────────────────────────────────────────
 *
 * A hospitality tab is reopened over and over: a waiter seats a table, rings a
 * round, walks away, comes back twenty minutes later and adds a main. On that
 * second visit the basket on screen mixes two entirely different kinds of line —
 * the ones the kitchen already has and the ones the waiter has just added — and
 * they look identical.
 *
 * That is the mistake this exists to prevent. A waiter who cannot tell which
 * lines are new either re-sends the whole tab (and the kitchen cooks the
 * starters twice) or sends nothing (and the main never arrives). Both happen on
 * a screen where every line looks the same.
 *
 * So each line reports one of three states, against a BASELINE taken the moment
 * the tab came back on screen:
 *
 *   · `unmodified` — was here when the table was reopened, untouched since.
 *   · `modified`   — was here, and something about it has changed since.
 *   · `new`        — was not here at all; added in this sitting.
 *
 * ── "SESSION" MEANS ONE OPENING OF ONE TAB ────────────────────────────────
 *
 * Not a login, not a till shift. From the moment a basket is loaded — recalled
 * tab, reopened table, restored park — to the moment it is paid, parked or
 * cleared. A basket that was never loaded from anywhere has no baseline and
 * every line in it is `new`, which is the true answer for a counter sale: the
 * cashier rang all of it just now.
 *
 * ── PURE, LIKE basket.ts ──────────────────────────────────────────────────
 *
 * Value in, value out. No React, no clock of its own — `now` is passed in — and
 * no database. That is what lets the reducer own the baseline, lets the offline
 * till compute the same badges with no network, and lets a test check the
 * "modified" rule without standing up a POS.
 */

export type LineSessionState = 'unmodified' | 'modified' | 'new'

/**
 * The comparable facts about a line, frozen at the moment a tab was loaded.
 *
 * Deliberately NOT the whole `BasketLine`. `key` is regenerated on every recall
 * and would never match; a stored snapshot of every field would make this
 * change every time an unrelated field is added to the basket. What is here is
 * what a waiter would call "the line changed": how many, at what price, with
 * what discount, and with which answers to the kitchen's questions.
 */
export type LineBaseline = {
  qty: number
  unitPriceIncl: number
  discountPct: number
  /** The chosen answers, flattened to a stable string. See `instructionFingerprint`. */
  instructions: string
  note: string
}

/**
 * The baseline for one whole basket, keyed by line.
 *
 * `null` means "this basket was not loaded from anywhere" — a fresh counter
 * sale — which is a different thing from an empty baseline (a tab that was
 * reopened with nothing on it). The first makes every line `new`; so does the
 * second, but only because every line genuinely was added after the load.
 */
export type SessionBaseline = Record<string, LineBaseline> | null

/**
 * The answers on a line, as one comparable string.
 *
 * Sorted, because two identical selections made in a different order are the
 * same burger and must not read as a modification. Option id and quantity are
 * both in the key: swapping one bacon for two is a change the kitchen has to
 * hear about.
 */
export function instructionFingerprint(instructions: BasketLine['instructions']): string {
  return instructions
    .map((o) => `${o.optionId}:${o.qty}`)
    .sort()
    .join('|')
}

/** The comparable facts of a line, right now. */
export function baselineOf(line: BasketLine): LineBaseline {
  return {
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    instructions: instructionFingerprint(line.instructions),
    note: line.note,
  }
}

/**
 * Freezes a whole basket as the baseline for a new session.
 *
 * Called at exactly one moment — when a basket is LOADED — and never again
 * while that basket is on screen. Re-taking it after an edit is what would
 * quietly turn every modification back into `unmodified`, which is the failure
 * this whole module exists to prevent.
 */
export function captureBaseline(lines: readonly BasketLine[]): SessionBaseline {
  const out: Record<string, LineBaseline> = {}
  for (const line of lines) out[line.key] = baselineOf(line)
  return out
}

/**
 * What has happened to this line since the tab was opened.
 *
 * A line whose key is absent from the baseline is `new`. That is sound because
 * recall mints keys server-side (`r{doc}-{line}-{index}`) and the baseline is
 * taken from those same keys in the same breath — so a key can only be missing
 * if the line was added afterwards.
 */
export function lineSessionState(line: BasketLine, baseline: SessionBaseline): LineSessionState {
  if (!baseline) return 'new'
  const was = baseline[line.key]
  if (!was) return 'new'
  const now = baselineOf(line)
  const same =
    was.qty === now.qty &&
    was.unitPriceIncl === now.unitPriceIncl &&
    was.discountPct === now.discountPct &&
    was.instructions === now.instructions &&
    was.note === now.note
  return same ? 'unmodified' : 'modified'
}

/**
 * How long ago this line was ordered, in whole minutes.
 *
 * Floored, not rounded: a line rung fifty seconds ago reads "0 minutes", which
 * is what a waiter means by "just now". Rounding would have it claim a minute
 * had passed before one had.
 *
 * Clamped at zero. A tab carries its order time across tills, and two machines
 * whose clocks disagree by a few seconds must not produce "-1 minutes".
 */
export function minutesSince(orderedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - orderedAt) / 60_000))
}

/**
 * That figure as a waiter would say it.
 *
 * Minutes the whole way up rather than switching to hours, because the number
 * is being compared against how long a plate SHOULD take: "95 minutes" is
 * instantly alarming in a way "1h 35m" is not.
 */
export function formatLineAge(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

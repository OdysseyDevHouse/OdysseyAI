/**
 * Which till a shop runs.
 *
 * Plain values with no imports, so a server page, a client shell and a pure test
 * can all name the same three things — the same reasoning `openTill.ts` gives for
 * not marking itself `'use client'`.
 *
 * ── WHY THIS IS A SCREEN CHOICE AND NOT A SET OF FLAGS ────────────────────
 *
 * The hospitality flag was introduced with a note in `settings.ts` saying it was
 * read in exactly three places, and that a fourth would mean it was being
 * threaded rather than contained. It is now read nine times in PosShell alone
 * and appears in 28 files.
 *
 * That is what a boolean does when it answers "what kind of screen is this".
 * Every new behaviour finds one more place to ask, and a shell that serves two
 * shapes ends up serving neither well. A third value threaded the same way would
 * decay faster, because three modes have more combinations than two.
 *
 * So the mode is resolved ONCE, at the entry, and picks a shell. Everything
 * underneath — the basket, the money, the offline layer, the actions — is shared
 * by all three because none of it depends on which shop this is.
 */

export const POS_MODES = ['retail', 'hospitality', 'invoicing'] as const
export type PosMode = (typeof POS_MODES)[number]

/**
 * Reads a stored setting into a mode, safely.
 *
 * Anything unrecognised is 'retail'. That covers an empty setting on a shop that
 * has never chosen, and a value written by a newer build than the one reading it
 * — and in both cases a counter till is the answer that trades, which is the
 * property that matters when the alternative is a screen that will not open.
 */
export function toPosMode(value: unknown): PosMode {
  return (POS_MODES as readonly string[]).includes(String(value))
    ? (value as PosMode)
    : 'retail'
}

/** What the mode is called on a settings screen. */
export const POS_MODE_LABELS: Record<PosMode, string> = {
  retail: 'Retail counter',
  hospitality: 'Tables',
  invoicing: 'Trade counter',
}

/**
 * One line on why a shop would pick each, for the setting that offers them.
 *
 * Written as what the shop DOES rather than what the software has: somebody
 * choosing between these knows their own trade, not our vocabulary.
 */
export const POS_MODE_HINTS: Record<PosMode, string> = {
  retail: 'A queue at a till. One basket at a time, paid before the customer leaves.',
  hospitality: 'Tables and tabs. A bill per table, held open while people eat.',
  invoicing:
    'A trade counter. Long documents typed line by line — invoices, quotes and orders for account customers.',
}

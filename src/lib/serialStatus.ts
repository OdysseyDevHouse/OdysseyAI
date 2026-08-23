/**
 * What state an individual serial-tracked unit is in.
 *
 * Lives here rather than in `lib/site/serials.ts` because the capture screen is
 * a client component and needs the labels: that module is `server-only` and
 * imports the database pool, so importing a single label off it would pull
 * mysql2 into the browser bundle. Types erase at compile time; constants do not.
 *
 * The values match the ENUM in migration 021.
 */

export const SERIAL_STATUSES = [
  'in_stock',
  'sold',
  'returned',
  'written_off',
  'returned_to_supplier',
] as const
export type SerialStatus = (typeof SERIAL_STATUSES)[number]

/**
 * `returned` and `returned_to_supplier` are deliberately separate.
 *
 * The first is a faulty unit the shop is still holding and has to decide about;
 * the second has physically left the building and been credited. Only one of
 * them is an answer to "what faulty stock am I sitting on?".
 */
export const SERIAL_LABELS: Record<SerialStatus, string> = {
  in_stock: 'In stock',
  sold: 'Sold',
  returned: 'Returned — not resellable',
  written_off: 'Written off',
  returned_to_supplier: 'Returned to supplier',
}

/* ── Allocating a serial to a job line (§31) ─────────────────────────────── */

/**
 * What the screen shows about ONE serial somebody has typed or scanned.
 *
 * ── WHY THIS IS NOT `SerialStatus` ──────────────────────────────────────────
 *
 * `SerialStatus` is a property of the UNIT: what the shop's records say about
 * it, independent of anybody asking. This is the answer to a QUESTION — "may
 * this unit go on this line, right now" — and the two differ in ways that
 * matter.
 *
 * A unit that is `in_stock` is `wrong_product` when it belongs to something
 * else, and `elsewhere` when it is sitting in another branch. A serial nobody
 * has ever received is not a status at all, because there is no row to hold one.
 * And `duplicate` is not about the unit either — it is about the same one being
 * entered twice on one line.
 *
 * ── WHY SIX AND NOT A BOOLEAN ───────────────────────────────────────────────
 *
 * §31 asks for exactly these, and the reason is that the fix differs for each.
 * "Not allocated" is finish the job; "unknown" is receive it first; "elsewhere"
 * is transfer it; "used" is find out who has it. A screen that said only "not
 * valid" would send a technician to the office for every one of them.
 */
export const SERIAL_ALLOC_STATES = [
  'valid',
  'unknown',
  'wrong_product',
  'unavailable',
  'elsewhere',
  'duplicate',
] as const
export type SerialAllocState = (typeof SERIAL_ALLOC_STATES)[number]

export const SERIAL_ALLOC_LABEL: Record<SerialAllocState, string> = {
  valid: 'Ready',
  unknown: 'Not on file',
  wrong_product: 'Wrong product',
  unavailable: 'Not available',
  elsewhere: 'At another location',
  duplicate: 'Entered twice',
}

/**
 * The tone each state renders in.
 *
 * §31 is explicit that state must never be carried by colour alone, so every
 * caller pairs this with SERIAL_ALLOC_LABEL. The tone is the glance; the label
 * is the answer.
 */
export const SERIAL_ALLOC_TONE: Record<SerialAllocState, 'success' | 'warning' | 'danger'> = {
  valid: 'success',
  unknown: 'warning',
  wrong_product: 'danger',
  unavailable: 'danger',
  elsewhere: 'warning',
  duplicate: 'danger',
}

/**
 * What to do about it, in the words of somebody standing at a van.
 *
 * `elsewhere` and `unknown` are WARNINGS rather than errors because both have an
 * ordinary path forward that the person can take: bring it across, or book it
 * in. The three danger states mean the serial in their hand is not the one this
 * line can use.
 */
export const SERIAL_ALLOC_HINT: Record<SerialAllocState, string> = {
  valid: 'In stock here and free to use.',
  unknown: 'No record of this one. It has to be received or adjusted in before it can be fitted.',
  wrong_product: 'That serial belongs to a different product.',
  unavailable: 'Already sold, written off or sent back.',
  elsewhere: 'On file, but held somewhere else. Transfer it across first.',
  duplicate: 'The same serial is on this line more than once.',
}

/** Only a `valid` serial may be allocated. Everything else needs a decision. */
export function isAllocatable(state: SerialAllocState): boolean {
  return state === 'valid'
}

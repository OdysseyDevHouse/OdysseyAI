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

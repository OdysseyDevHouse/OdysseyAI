import { BASE_MODULE, type ModuleKey } from './control/moduleCatalogue'

/**
 * The things a shop can switch off under Setup → Menu & modules.
 *
 * ── WHY THIS IS WIDER THAN THE MODULE LIST ──────────────────────────────────
 *
 * The screen started as one switch per MODULE, which is the wrong frame: it
 * answers "what did you buy" when the reader is asking "what do I not use". The
 * two lists mostly overlap and then disagree at the edges, in both directions.
 *
 *   - Staff is in the base package, so every shop carries the clock, timesheets,
 *     leave and commission. A two-person shop that pays cash and keeps no roster
 *     uses none of it, and had no way to put it away.
 *   - Tickets is likewise base-package but is not its own idea — a shop that has
 *     switched off Job Cards has said it does not take work in and track it, so
 *     the ticket desk should go with it.
 *   - Multi-Branch had a switch and should not have: it is not a section
 *     somebody browses past, and hiding it costs a single Setup tile.
 *
 * So the unit is a MENU AREA — a part of the product somebody either uses or
 * does not — and a module is simply the commonest kind of one. `AREA_MODULE`
 * below says which areas are also things you buy; the rest are base-package and
 * always offered.
 *
 * Client-safe on purpose (no `server-only`), because the switch list renders in
 * the browser. See moduleCatalogue.ts for the same split one layer down.
 */

/**
 * Every switch, in the order the screen shows them.
 *
 * PERSISTED strings — they go into `hidden_modules` as a CSV — so renaming one
 * orphans the row that carries it. Add to the end rather than reordering when
 * that is all a change needs.
 */
export const MENU_AREAS = [
  'inventory_advanced',
  'customers',
  'online_store',
  'loyalty',
  'job_cards',
  'accounting',
  'staff',
] as const

export type MenuArea = (typeof MENU_AREAS)[number]

/**
 * The module an area is SOLD as, where it is sold at all.
 *
 * An area with no entry here is part of the base package: every shop has it, so
 * it is always offered as a switch and its visibility is decided by this setting
 * alone. An area WITH one is only offered to a shop that holds that module —
 * there is no point asking somebody whether to hide a thing they do not have,
 * and a switch for it would read as a way to turn it on.
 *
 * Every value is a real ModuleKey, checked by the type. `multi_branch` is
 * deliberately absent: it is a module, but not an area anybody browses.
 */
export const AREA_MODULE: Partial<Record<MenuArea, ModuleKey>> = {
  inventory_advanced: 'inventory_advanced',
  customers: 'customers',
  online_store: 'online_store',
  loyalty: 'loyalty',
  job_cards: 'job_cards',
  accounting: 'accounting',
}

/** Human names, in menu words rather than price-book words. */
export const AREA_LABELS: Record<MenuArea, string> = {
  inventory_advanced: 'Stock control',
  customers: 'Customers',
  online_store: 'Online store',
  loyalty: 'Loyalty',
  job_cards: 'Jobs & tickets',
  accounting: 'Accounting',
  staff: 'Staff',
}

/**
 * What actually leaves the menu, named as rows the reader can go and look at.
 *
 * Deliberately not `MODULE_DESCRIPTIONS`: that list SELLS the module, because it
 * is written for /upgrade where the reader has not got the feature. This reader
 * has it and is deciding whether to put it away, so the useful sentence is which
 * rows disappear. Kept to one line — seven of these are read at a glance, and a
 * paragraph each turns a scan into a document.
 */
export const AREA_EFFECT: Record<MenuArea, string> = {
  inventory_advanced: 'Stock takes, Transfers, Adjustments, Batches and Manufacturing.',
  customers: 'The Customers section — accounts, statements, age analysis and collections.',
  online_store: 'The Online Store section — catalogue, orders and the storefront.',
  loyalty: 'The Loyalty section — members, points and tiers.',
  job_cards: 'The Jobs and Tickets sections — the board, scheduling and equipment.',
  accounting: 'The ledger tiles on the Accounting hub — journals, budgets, fixed assets and periods.',
  staff: 'The Staff section — clock-in, timesheets, leave, people and commission.',
}

/** Whether a string names an area. For reading a stored CSV back. */
export function isMenuArea(value: string): value is MenuArea {
  return (MENU_AREAS as readonly string[]).includes(value)
}

/**
 * Whether a stored key is one this shop may still be shown a switch for.
 *
 * `starter` is refused outright wherever it appears: it is the base package
 * every un-gated screen lives in, so hiding it would empty the menu with no
 * obvious way back.
 */
export function isHideable(value: string): boolean {
  return value !== BASE_MODULE && isMenuArea(value)
}

/**
 * Areas this shop is entitled to, and so may be offered a switch for.
 *
 * A base-package area is always offered. A sold one is offered only when held —
 * asking somebody whether to hide Loyalty when they never bought it invites the
 * click that appears to do nothing.
 */
export function areasFor(held: ReadonlySet<string>): MenuArea[] {
  return MENU_AREAS.filter((area) => {
    const module = AREA_MODULE[area]
    return !module || held.has(module)
  })
}

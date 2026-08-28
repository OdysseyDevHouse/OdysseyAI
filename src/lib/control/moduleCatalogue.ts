/**
 * The module catalogue as pure DATA — no database, no `server-only`.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────
 *
 * These four constants sat in `modules.ts`, which is `server-only` and reaches
 * `next/headers` through the licence lease. Any client component naming a module
 * — a settings screen with a switch per module is the obvious one — therefore
 * could not import the LABEL without dragging the whole control database into
 * the browser bundle, and the failure is a build error a long way from the
 * import that caused it.
 *
 * The same split `moduleMessages.ts` already makes, for the same reason and one
 * layer lower: that file holds the SENTENCES a client may need, this one holds
 * the KEYS and NAMES they are written about.
 *
 * `modules.ts` re-exports every name here, so nothing that already imports from
 * there has to change and there is still one obvious place to ask what a module
 * is. New client code should import from this file directly.
 */

/**
 * The catalogue. These strings are PERSISTED, so they are permanent — renaming
 * one orphans every row that carries it.
 *
 * No dots, deliberately: `loyalty.view` is a capability and `loyalty` is a
 * module, and the two get passed to similarly-shaped predicates. Making them
 * look different is the cheapest guard against one being handed to the other.
 */
export const MODULE_KEYS = [
  'starter',
  'inventory_advanced',
  'multi_branch',
  'customers',
  'online_store',
  'loyalty',
  'job_cards',
  'accounting',
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

/**
 * Always held, never sold separately, cannot be removed.
 *
 * It is in the price book because it appears on the bill, but it is not
 * something a screen ever gates on: every site has it by definition, so
 * `has(e, 'starter')` is always true and a guard written against it would be
 * dead code that reads like a real check.
 */
export const BASE_MODULE: ModuleKey = 'starter'

/**
 * POS device licences: a QUANTITY, not a feature.
 *
 * Deliberately outside ModuleKey. Nothing gates on it — cp2_devices is the
 * authority for whether a till may trade, and this key exists only so the
 * licences appear as a line on the same bill as everything else.
 */
export const DEVICE_MODULE_KEY = 'pos_device'

/** Human names for the catalogue. The billing screen and /upgrade share these. */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  starter: 'Starter Pack',
  inventory_advanced: 'Advanced Inventory',
  multi_branch: 'Multi-Branch',
  customers: 'Customers',
  online_store: 'Online Store',
  loyalty: 'Loyalty',
  job_cards: 'Job Cards',
  accounting: 'Accounting',
}

import type { Capability } from './site/permissions'

/**
 * Quick keys — what a shop puts on its own till buttons.
 *
 * ── PURE, AND THAT IS THE POINT ───────────────────────────────────────────
 *
 * No `server-only` and no `'use client'`, so the designer, the till and the server
 * validator all read ONE definition of what a key can be. The alternative is a slug
 * list in the designer that has drifted from the runner's dispatch table, which shows
 * up as a key that saves happily and does nothing when pressed.
 *
 * The `Capability` import is TYPE-ONLY. `permissions.ts` is `server-only`, but a type
 * import is erased at compile time, so this costs the client bundle nothing — and it
 * buys the thing that matters: a capability typo here is a compile error rather than a
 * key nobody can press.
 */

export type QuickKeySection = 'main' | 'tables'
export type QuickKeyKind = 'action' | 'product' | 'department' | 'group'

export type QuickKeyAction = {
  slug: string
  /** What the key says when the shop has not typed its own caption. */
  label: string
  /** A name from QUICK_KEY_ICONS — never an SVG, never an emoji. */
  icon: string
  /**
   * What this key needs. Typed, so a made-up capability does not compile.
   *
   * This is the SCREEN's gate — it decides whether the key is offered and whether it
   * greys out. Every action behind it re-checks for itself, because a server action is
   * a public endpoint and hiding a button changes what is easy rather than what is
   * possible.
   */
  capability: Capability
  /**
   * Only meaningful on a restaurant till.
   *
   * Kept in the catalogue rather than omitted so the designer can show it greyed with
   * a reason, instead of a shop wondering why the POS it read about has no
   * send-to-kitchen key.
   */
  hospitalityOnly?: boolean
  /** One line for the designer's list — what pressing it actually does. */
  hint: string
}

/**
 * Every action a quick key can run.
 *
 * ── WHY THE CAPABILITIES ARE NOT THE OBVIOUS ONES ─────────────────────────
 *
 * Two are worth reading twice:
 *
 * `void-sale` takes `sales.till`, NOT `sales.void`. They are different acts in this
 * app: `sales.void` reverses a FINALISED invoice — stock back, ledger reversed, number
 * kept as cancelled — while this key clears a basket that has not posted. Nothing has
 * happened yet, so requiring the heavier right would stop a cashier abandoning a
 * mis-scan, and they would work around it by ringing it up and voiding it properly,
 * which is worse.
 *
 * `customer-payment` takes `cashbook.edit`, because taking money against an account is
 * a cashbook receipt rather than a sale. A cashier allowed to sell is not automatically
 * allowed to receipt.
 */
export const QUICK_KEY_ACTIONS: readonly QuickKeyAction[] = [
  {
    slug: 'void-sale',
    label: 'Void sale',
    icon: 'Trash',
    capability: 'sales.till',
    hint: 'Clears the basket. Nothing has posted, so nothing is reversed.',
  },
  {
    slug: 'save-sale',
    label: 'Save sale',
    icon: 'Save',
    capability: 'sales.till',
    hint: 'Parks the basket so the next customer can be served.',
  },
  {
    slug: 'view-saved-sales',
    label: 'Saved sales',
    icon: 'ListOrdered',
    capability: 'sales.view',
    hint: 'The parked baskets, to bring one back.',
  },
  {
    slug: 'undo',
    label: 'Undo',
    icon: 'Reverse',
    capability: 'sales.till',
    hint: 'Removes the last line added.',
  },
  {
    slug: 'global-discount',
    label: 'Discount',
    icon: 'Percent',
    capability: 'sales.discount_override',
    hint: 'A discount across the whole sale.',
  },
  {
    slug: 'price-change',
    label: 'Change price',
    icon: 'Tag',
    capability: 'sales.price_override',
    hint: 'Overrides the price on the selected line.',
  },
  {
    slug: 'price-enquiry',
    label: 'Price check',
    icon: 'Search',
    capability: 'products.view',
    hint: 'Looks a price up without adding it to the sale.',
  },
  {
    slug: 'customer-payment',
    label: 'Take a payment',
    icon: 'HandCoins',
    capability: 'cashbook.edit',
    hint: 'Receipts money against a customer account.',
  },
  {
    slug: 'credit-sale',
    label: 'Account sale',
    icon: 'Contact',
    capability: 'customers.credit',
    hint: 'Puts the sale on a customer account.',
  },
  {
    slug: 'cashup',
    label: 'Cash up',
    icon: 'Coins',
    capability: 'sales.cashup',
    hint: 'Counts the drawer and closes the shift.',
  },
  {
    slug: 'refund',
    label: 'Refund',
    icon: 'Reverse',
    capability: 'sales.credit_note',
    hint: 'Credits goods coming back.',
  },
  {
    slug: 'redeem-voucher',
    label: 'Voucher',
    icon: 'Ticket',
    capability: 'loyalty.view',
    hint: 'Takes a loyalty voucher against the sale.',
  },
  {
    slug: 'loyalty-payment',
    label: 'Pay with points',
    icon: 'Gem',
    capability: 'loyalty.adjust',
    hint: 'Spends a member’s points or wallet.',
  },
  {
    slug: 'reprint-invoice',
    label: 'Reprint',
    icon: 'Printer',
    capability: 'sales.view',
    hint: 'Opens a past sale to print again.',
  },
  {
    slug: 'reprint-last-slip',
    label: 'Reprint last',
    icon: 'Printer',
    capability: 'sales.view',
    hint: 'Opens the sale just completed.',
  },
  {
    slug: 'online-orders',
    label: 'Online orders',
    icon: 'ShoppingCart',
    capability: 'online.view',
    hint: 'Orders waiting to be picked or collected.',
  },
  {
    slug: 'clock-in-out',
    label: 'Clock in / out',
    icon: 'Clock',
    capability: 'staff.clock',
    hint: 'Starts or ends a shift on the time clock.',
  },
  /* Two this app has and the reference POS does not. A basket is a basket until
     somebody says what it is, and an order and a lay-by are both "not yet a sale". */
  {
    slug: 'save-as-order',
    label: 'Save as order',
    icon: 'ListOrdered',
    capability: 'sales.edit',
    hint: 'Turns the basket into a sales order, reserving the stock.',
  },
  {
    slug: 'save-as-layby',
    label: 'Save as lay-by',
    icon: 'Package',
    capability: 'sales.view',
    hint: 'Starts a lay-by against the basket.',
  },

  /* ── Hospitality ────────────────────────────────────────────────────────
     Declared now so the designer can show them greyed with a reason on a retail
     till, rather than a shop wondering where they went. The runner stubs them
     until phase 6. */
  {
    slug: 'bill-print',
    label: 'Print the bill',
    icon: 'Printer',
    capability: 'sales.till',
    hospitalityOnly: true,
    hint: 'Prints a table’s bill before it is paid.',
  },
  {
    slug: 'table-transfer',
    label: 'Move table',
    icon: 'ArrowLeftRight',
    capability: 'sales.till',
    hospitalityOnly: true,
    hint: 'Moves a bill to a different table.',
  },
  {
    slug: 'split-table',
    label: 'Split the bill',
    icon: 'Shapes',
    capability: 'sales.till',
    hospitalityOnly: true,
    hint: 'Divides a table’s bill between payers.',
  },
  {
    slug: 'add-tip',
    label: 'Add a tip',
    icon: 'Coins',
    capability: 'sales.till',
    hospitalityOnly: true,
    hint: 'Adds a gratuity to the bill.',
  },
  {
    slug: 'send-to-kitchen',
    label: 'Send to kitchen',
    icon: 'Send',
    capability: 'sales.till',
    hospitalityOnly: true,
    hint: 'Sends the ordered items through to be made.',
  },
] as const

const BY_SLUG = new Map(QUICK_KEY_ACTIONS.map((a) => [a.slug, a]))

export function actionForSlug(slug: string): QuickKeyAction | null {
  return BY_SLUG.get(slug) ?? null
}

/* ── The slot signature ──────────────────────────────────────────────────── */

export type QuickKeyTarget =
  | { kind: 'action'; actionSlug: string }
  | { kind: 'product'; productId: number }
  | { kind: 'department'; departmentId: number }
  | { kind: 'group' }

/**
 * The key's target as one string, for `uq_slot`.
 *
 * SERVER-WRITTEN. It is derived from the other columns, so a client that could set it
 * independently could make it disagree with them — and the uniqueness it enforces
 * would then be uniqueness of nothing. Exported as a pure function so the server and
 * a test compute it identically.
 *
 * A group's signature is its CAPTION, lowercased. Nothing else identifies a folder —
 * it points at no product and runs no action — and two folders called "Drinks" on one
 * bar is a shop asking which one holds the Coke.
 */
export function quickKeySig(target: QuickKeyTarget, caption = ''): string {
  switch (target.kind) {
    case 'action':
      return `a:${target.actionSlug}`
    case 'product':
      return `p:${target.productId}`
    case 'department':
      return `d:${target.departmentId}`
    case 'group':
      return `g:${caption.trim().toLowerCase() || 'group'}`
  }
}

/** The supervisor folder every till gets, by signature. Undeletable. */
export const SUPERVISOR_GROUP_SIG = 'g:supervisor'

/**
 * What a key needs, whatever kind it is.
 *
 * A product or department key is a way of adding to a sale, so it needs `sales.till`
 * and nothing more. A group needs nothing — a folder grants no rights; the keys inside
 * it carry their own, which is what stops "hide it in a folder" being a way around a
 * capability.
 */
export function quickKeyCapability(
  kind: QuickKeyKind,
  actionSlug: string,
): Capability | null {
  if (kind === 'group') return null
  if (kind === 'action') return actionForSlug(actionSlug)?.capability ?? null
  return 'sales.till'
}

/* ── Arranging ───────────────────────────────────────────────────────────── */

export type QuickKeyRow = {
  id: number
  parentId: number | null
  section: QuickKeySection
  kind: QuickKeyKind
  actionSlug: string
  productId: number | null
  departmentId: number | null
  caption: string
  icon: string
  colourToken: string
  position: number
  isHidden: boolean
  requireAuth: boolean
  capability: string
  sig: string
}

/** Keys on the bar itself — the ones with no parent. */
export function topLevelKeys(
  keys: readonly QuickKeyRow[],
  section: QuickKeySection = 'main',
): QuickKeyRow[] {
  return keys.filter((k) => k.section === section && k.parentId === null).sort(byPosition)
}

/** What is inside one group. */
export function groupMembers(keys: readonly QuickKeyRow[], groupId: number): QuickKeyRow[] {
  return keys.filter((k) => k.parentId === groupId).sort(byPosition)
}

/**
 * Position, then id.
 *
 * The id tiebreak matters: positions are renumbered per scope on every move, and two
 * keys briefly sharing one would otherwise render in whatever order the database
 * returned them — which is stable enough to look fine and unstable enough to swap
 * after an unrelated edit.
 */
export function byPosition(a: QuickKeyRow, b: QuickKeyRow): number {
  return a.position - b.position || a.id - b.id
}

/**
 * What a key should SAY, given what it points at.
 *
 * The shop's own caption wins. Otherwise the target names itself — a product key with
 * no caption reads the product's description, so renaming the product renames the key
 * and a shop never has to maintain the same words twice.
 */
export function quickKeyLabel(
  key: Pick<QuickKeyRow, 'kind' | 'caption' | 'actionSlug'>,
  targetName?: string | null,
): string {
  const own = key.caption.trim()
  if (own) return own
  if (key.kind === 'action') return actionForSlug(key.actionSlug)?.label ?? key.actionSlug
  return targetName?.trim() || 'Untitled'
}

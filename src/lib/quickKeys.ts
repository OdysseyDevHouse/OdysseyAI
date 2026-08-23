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

/**
 * The bars a till can have, and what each is FOR.
 *
 * Two, because a restaurant till answers two different questions. At the counter the
 * cashier is building a basket, so the keys are the ones that sell and settle. With a
 * table open the waiter is managing a bill that will not be paid for an hour, so the
 * keys are print it, move it, split it, tip it.
 *
 * A retail shop only ever sees `main`. The second bar is offered on a hospitality till
 * alone — see the designer, which hides the tab rather than showing an empty one.
 *
 * Kept here beside the type rather than in the designer so the label a manager arranges
 * under and the label anything else uses cannot drift apart.
 */
export const QUICK_KEY_SECTIONS: readonly {
  section: QuickKeySection
  label: string
  /** Reads into a sentence: "…at the end of the bar". */
  phrase: string
  hint: string
  hospitalityOnly?: boolean
}[] = [
  {
    section: 'main',
    label: 'Main keys',
    phrase: 'the main bar',
    hint: 'What a cashier sees on the till’s catalogue pane.',
  },
  {
    section: 'tables',
    label: 'Open tables',
    phrase: 'the tables bar',
    hint: 'What a waiter sees with a table open — the keys for a bill in progress.',
    hospitalityOnly: true,
  },
]

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
  /**
   * The mirror: only meaningful on a RETAIL till.
   *
   * RECALLING a parked basket is a retail act. On a restaurant till the floor
   * already lists every open tab, so a "Saved sales" key is a second floor beside
   * the gate — two lists of the same bills, disagreeing the moment one is stale.
   *
   * Saving used to be here too. It is not any more: `save-sale` now runs the same
   * naming-and-parking path as Close, so on a restaurant till it is that act on a
   * key rather than a worse imitation of it. What made it retail-only was the
   * anonymous park, and that is gone.
   */
  retailOnly?: boolean
  /**
   * Why this one is retail-only, when the default sentence would not fit.
   *
   * The default answers "a table is already your parked basket", which is true
   * of the saved-sales key and of nothing else. The document lists are retail
   * for a different reason — a restaurant does not quote, order or lay by — and
   * telling a manager the wrong reason is worse than telling them none.
   */
  retailReason?: string
  /**
   * Meaningless on the TABLES bar, even on a restaurant till.
   *
   * Not the same flag as `retailOnly`. That one is about the shop; this is about which
   * bar, on the one shop that has two. Cashing up is a till-level act and a table is
   * open — pressing it there is either refused or, worse, closes the shift under a
   * bill somebody is still eating.
   *
   * Kept as a flag rather than a second catalogue so an action is declared once. The
   * designer greys it in the rail with a reason; `quickKeyAllowedOnSection` is the
   * single test, and the server calls the same one.
   */
  noTables?: boolean
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
    /*
     * NOT retailOnly, and it was until this key became Close.
     *
     * The flag was right while the key parked anonymously: on a restaurant till
     * that is a second, worse way to do what Close already does properly. Now it
     * IS Close — same function, same naming prompt — so it is simply the same act
     * on a key a shop can place where it likes, which is what the whole designer
     * is for. A waiter with Save on the tables bar saves the table.
     */
    hint: 'Saves the basket. Asks what to call it if it has no name yet.',
  },

  /*
   * ── NO DOCUMENT-LIST KEYS ─────────────────────────────────────────────────
   *
   * Saved sales, quotes, orders and lay-bys are deliberately absent, and this
   * note is here so they are not put back.
   *
   * Every one of those piles already has its own way in from the till: picking
   * the module opens the list (`openModuleList` in PosShell) — saved sales on
   * the sale module, and a lay-by, which is list-only since the basket is never
   * one, opens on the pick itself. A key beside that is a second button for an
   * act the till already puts one press away, and this catalogue is for the
   * acts that have nowhere else to live.
   *
   * `save-sale` above is NOT the same case and stays. Saving is a thing the
   * cashier DOES to the basket in front of them; finding one again is a list
   * the module menu already carries.
   */
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
    slug: 'gift-card-balance',
    label: 'Gift card balance',
    icon: 'Gift',
    capability: 'sales.till',
    hint: 'Checks what a card is holding, without a sale.',
  },
  {
    slug: 'customer-payment',
    label: 'Take a payment',
    icon: 'HandCoins',
    capability: 'cashbook.edit',
    hint: 'Receipts money against a customer account.',
  },
  {
    /*
     * `sales.till`, NOT `cashbook.edit` like the key above it.
     *
     * A deposit reaches no cashbook and no ledger — the money is held against
     * the document until the goods are handed over, so there is no receipt to
     * post and no debtor to move. It is the same act as taking money for goods,
     * which is what the till right already covers.
     */
    slug: 'take-deposit',
    label: 'Take a deposit',
    /* HandCoins, same as the payment key. `icon` is a plain string resolved at
       render, so a name the icons module does not export draws nothing at all —
       verified against icons.tsx rather than guessed. */
    icon: 'HandCoins',
    capability: 'sales.till',
    hint: 'Holds money against the sale on screen.',
  },
  /*
   * ── CREDIT SALE, AND WHY IT IS NOT `refund` ───────────────────────────────
   *
   * This slug used to be "Account sale" and opened the customer picker — the
   * same dialog the customer button at the head of the slip already shows. It
   * was removed for that duplication, and the name is now free for the act that
   * genuinely needs a key of its own.
   *
   * A credit sale reverses a PAST SALE: find the receipt, pick the lines off it,
   * credit them at the prices printed on it. That is the ordinary way goods come
   * back, because the customer gets back what they actually paid rather than
   * today's shelf figure — a discounted sale credited at full price is a shop
   * paying out money it never took.
   *
   * This is what `refund` used to do. The two acts are genuinely different and
   * now have a key each: this one settles a document that already exists, and
   * `refund` below takes an item back into the basket in front of the cashier,
   * with no paperwork to find. A cashier who has the slip should reach for this
   * one every time.
   *
   * Not placed on the default boards. Both keys are ordinary catalogue entries
   * and the designer is where a manager puts the ones their counter uses.
   */
  {
    slug: 'credit-sale',
    label: 'Credit sale',
    icon: 'Reverse',
    capability: 'sales.credit_note',
    hint: 'Finds a past sale and credits it back.',
  },
  {
    slug: 'cashup',
    label: 'Cash up',
    icon: 'Coins',
    capability: 'sales.cashup',
    /* Closing the shift is a till-level act. Offered while a table is open it would
       either be refused or, worse, cash the drawer up under a bill people are still
       eating against. */
    noTables: true,
    hint: 'Counts the drawer and closes the shift.',
  },
  /*
   * ── THE THREE DRAWER MOVEMENTS ────────────────────────────────────────────
   *
   * They used to live two taps inside the shift dialog. That was the wrong
   * depth: opening a shift happens once a day, but a payout happens whenever
   * the milk arrives — and it happens while somebody waits at the counter. A
   * key that is two taps and a dialog away is a key a cashier postpones, and a
   * postponed payout is a drawer short at close with nobody able to say why.
   *
   * Three separate slugs rather than one "drawer movement" key that asks which
   * kind. The shop arranges its own board, and a shop that only ever pays out
   * should be able to put THAT on the bar without carrying a menu for two
   * things it never does. It also makes each key one press instead of two.
   *
   * `noTables` for the reason `cashup` has it: money in and out of the drawer
   * is a till-level act, and a waiter with a bill open is not at the drawer.
   */
  {
    slug: 'payout',
    label: 'Payout',
    icon: 'Banknote',
    capability: 'sales.cashup',
    noTables: true,
    hint: 'Records money out of the drawer that is not a sale.',
  },
  {
    slug: 'payin',
    label: 'Pay in',
    icon: 'Wallet',
    capability: 'sales.cashup',
    noTables: true,
    hint: 'Records money put into the drawer that is not a sale.',
  },
  {
    slug: 'drop-to-safe',
    label: 'Drop to safe',
    icon: 'Lock',
    capability: 'sales.cashup',
    noTables: true,
    hint: 'Records cash skimmed out to the safe mid-shift.',
  },
  /*
   * ── REFUND IS A ONE-ITEM MODE, NOT A DOCUMENT ─────────────────────────────
   *
   * Pressing it ARMS the next item. The cashier presses Refund, scans the thing
   * the customer is handing back, and it lands on the slip as a negative line —
   * then the till is selling again with nothing to switch off.
   *
   * One item per press, deliberately. A mode that stays on until it is turned
   * off is a mode a cashier forgets they are in, and the cost of forgetting here
   * is a till that credits the next customer's shopping. Arming exactly one line
   * makes the dangerous state last for one scan, which is short enough that the
   * banner is still on screen when the item lands.
   *
   * It is for the mid-basket case: a customer at the counter swapping one thing,
   * with no slip in hand. When there IS a slip, `credit-sale` above is the right
   * key — it credits at the prices the customer actually paid.
   */
  {
    slug: 'refund',
    label: 'Refund',
    icon: 'Reverse',
    capability: 'sales.credit_note',
    hint: 'Arms the next item as a refund on this slip.',
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
    /* A queue of web orders is the opposite of the bill in front of the waiter. It
       belongs on the counter bar, where somebody is looking for the next thing to do. */
    noTables: true,
    hint: 'Orders waiting to be picked or collected.',
  },
  {
    slug: 'start-layby',
    label: 'Lay-by this',
    icon: 'Package',
    capability: 'sales.till',
    /* THE BASKET IS THE LAY-BY. A customer who cannot pay today has already had
       their goods rung up, and the alternative to this key is keying every line
       again on another screen while they watch. */
    hint: 'Puts the basket aside for a customer to pay off.',
  },
  {
    slug: 'clock-in-out',
    label: 'Clock in / out',
    icon: 'Clock',
    capability: 'staff.clock',
    /* Starting or ending a shift belongs to the person, not to the table in front of
       them. On the tables bar it is one more key between a waiter and the bill. */
    noTables: true,
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
  /*
   * REMOVED: `add-tip` ("Add a tip").
   *
   * The tender pad already declares tips, and it is the only place that can do
   * it correctly: a tip and change are two claims on ONE excess, and the pad is
   * where that excess exists and gets divided. This key never captured a tip at
   * all — it printed a sentence telling the cashier to go and use the pad — so
   * removing it takes away a signpost, not a feature.
   *
   * The `manual` source on `tips` is unaffected and still meaningful: a typed
   * amount is a manual tip whichever screen collects it. See sql/site/091_tips.
   */
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

/**
 * Whether an action makes sense on THIS KIND of till — and why not, when it does not.
 *
 * The mirror of `quickKeyAllowedOnSection`, which is about which BAR. This is about the
 * shop: a retail till has no tables, so the bill and kitchen keys have nothing to act on.
 *
 * `retailOnly` is the other direction and currently has no action using it — the keys
 * that did were the document lists, and those are gone from the catalogue for a reason
 * that had nothing to do with tables (see the note above `undo`). The flag and its
 * `retailReason` sentence are kept because the rule itself is still right: an action that
 * only makes sense at a counter should declare it here rather than in the designer.
 *
 * Returns null when it is fine, or the sentence to show. Unlike the section rule, an
 * action refused here is HIDDEN rather than greyed: the section rule answers "which bar
 * does this go on", which is worth telling somebody, while this one answers "does this
 * shop have this feature at all" — and a permanently dead row for a feature the shop
 * will never have is a line of noise in a list of twenty-five.
 */
export function quickKeyAllowedOnTill(
  key: { kind: QuickKeyKind; actionSlug?: string | null },
  hospitality: boolean,
): string | null {
  if (key.kind !== 'action') return null
  const action = actionForSlug(key.actionSlug ?? '')
  if (!action) return null
  if (action.retailOnly && hospitality) {
    /*
     * `retailReason` rather than one fixed sentence, because "the table is your
     * parked basket" answers a parking key exactly and answers a document key
     * with a non-sequitur. An action says why in its own words, or takes the
     * default. One flag, not two, since both mean the same thing to callers: hide it.
     */
    return (
      action.retailReason ??
      `${action.label} is for a counter till. With tables, the table is the parked basket.`
    )
  }
  if (action.hospitalityOnly && !hospitality) {
    return `${action.label} needs a restaurant till — this shop is set to retail.`
  }
  return null
}

/**
 * Whether a key may live on a given bar — and why not, when it may not.
 *
 * Returns null when it is allowed, or the sentence to show. One function so the rail's
 * greying-out, the drop refusal and the server's validation cannot disagree: a key the
 * designer offers and the server then rejects is a bug a shop reports as "it will not
 * save and it will not say why".
 *
 * Only ACTIONS are restricted. A product or a department is a way of adding to a bill,
 * which is exactly as sensible with a table open as without one.
 */
export function quickKeyAllowedOnSection(
  key: { kind: QuickKeyKind; actionSlug?: string | null },
  section: QuickKeySection,
): string | null {
  if (section !== 'tables' || key.kind !== 'action') return null
  const action = actionForSlug(key.actionSlug ?? '')
  if (!action?.noTables) return null
  return `${action.label} belongs on the main bar — it is a till-level action, not something to do with a table open.`
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
 * The icons a shop may choose from, by kit NAME.
 *
 * ── A CURATED LIST, NOT EVERY GLYPH IN THE KIT ────────────────────────────
 *
 * The kit re-exports hundreds of lucide icons. Offering all of them would be a picker
 * nobody can scan and a shop choosing `Atom` for a bread key. These are the ones that
 * mean something on a till, grouped so the picker can show them under headings.
 *
 * Names only — never an SVG and never an emoji. A name resolves through
 * `@/components/ui/icons`, so a restyle or an icon-set swap follows automatically;
 * a pasted SVG would be the one key that never changes again. Several of these names
 * ALSO have drawn art (see quickKeyArt), which wins where it exists — so picking
 * `Coins` on a product key gets the drawn coin rather than the line glyph.
 */
export const QUICK_KEY_ICONS: readonly { group: string; names: readonly string[] }[] = [
  {
    group: 'Money',
    /* `Banknote`, `Wallet` and `Lock` are the three drawer movements' defaults —
       money out, money in, money to the safe. Every icon an action ships with
       must appear here, or validation rejects the very name the server itself
       wrote when the key was created. Verified against icons.tsx: a name that
       module does not export draws nothing at all. */
    names: [
      'Coins',
      'HandCoins',
      'CreditCard',
      'Percent',
      'Tag',
      'Gem',
      'Ticket',
      'Gift',
      'Banknote',
      'Wallet',
      'Lock',
    ],
  },
  {
    group: 'The sale',
    names: [
      'Save',
      'Reverse',
      'Trash',
      'ListOrdered',
      'Package',
      'ShoppingCart',
      'Send',
      /* Also the catalogue's default for table-transfer. Every icon an action ships
         with must appear here, or validation would reject the very name the server
         itself wrote when the key was created. */
      'ArrowLeftRight',
    ],
  },
  {
    group: 'People',
    names: ['Contact', 'Users', 'ShieldCheck', 'KeyRound', 'Clock'],
  },
  {
    group: 'Stock',
    names: ['Boxes', 'PackageOpen', 'Warehouse', 'Barcode', 'Scale', 'Tags', 'Store', 'Truck'],
  },
  {
    group: 'Other',
    names: ['Printer', 'Search', 'Star', 'Heart', 'Zap', 'Sparkles', 'Shapes', 'LayoutGrid'],
  },
]

/** Every offerable icon name, flat — for validating what a client sent. */
export const QUICK_KEY_ICON_NAMES: ReadonlySet<string> = new Set(
  QUICK_KEY_ICONS.flatMap((g) => g.names),
)

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

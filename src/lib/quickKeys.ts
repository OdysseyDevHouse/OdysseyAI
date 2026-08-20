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
  {
    slug: 'view-saved-sales',
    label: 'Saved sales',
    icon: 'ListOrdered',
    capability: 'sales.view',
    retailOnly: true,
    hint: 'The parked baskets, to bring one back.',
  },

  /*
   * ── THE THREE LISTS ───────────────────────────────────────────────────────
   *
   * "Find an existing quote / order / lay-by" is one question asked of three
   * different piles, and until now only two of them had a way in from the till:
   * the basket carried a recall key that CHANGED MEANING with the module it was
   * showing. That key is gone. It cost every shop a strip of the basket, it sat
   * beside Save where a thumb rests, and it could only ever reach the list for
   * the module already on screen — so a cashier ringing a sale who was asked
   * about a quote had to switch module, binning the basket, to look one up.
   *
   * As keys they are three things a shop places, or does not, and any of them
   * opens over whatever is on screen without touching it. Three slugs rather
   * than one "Documents" key for the same reason the modals are separate: a
   * quote is answered by recalling it, an order by delivering it, a lay-by by
   * taking a payment against it. One key would have to ask which — which is the
   * question the cashier already answered by pressing it.
   *
   * All three take `sales.view`: this is reading the shop's documents, not
   * writing one. What they lead to re-checks for itself, as every action does.
   */
  /*
   * All three RETAIL-ONLY, which is the same call the module menu makes: it is
   * hidden on a restaurant till because every row behind it is a promise about
   * goods leaving the shop later, and a kitchen makes none of those. Offering
   * the same three as keys there would put the menu back one button at a time.
   */
  {
    slug: 'view-quotes',
    label: 'Quotes',
    icon: 'ListOrdered',
    capability: 'sales.view',
    retailOnly: true,
    retailReason: 'Quotes are a counter act — a restaurant till does not write them.',
    hint: "The shop's quotes, to bring one onto the till.",
  },
  {
    slug: 'view-orders',
    label: 'Orders',
    icon: 'Package',
    capability: 'sales.view',
    retailOnly: true,
    retailReason: 'Sales orders are a counter act — a restaurant till does not write them.',
    hint: 'Sales orders waiting to go out, to deliver one.',
  },
  {
    slug: 'view-laybys',
    label: 'Lay-bys',
    icon: 'PackageOpen',
    capability: 'sales.view',
    retailOnly: true,
    retailReason: 'Lay-bys are a counter act — a restaurant till does not write them.',
    hint: 'The lay-bys on the go, to take a payment or hand one over.',
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

/**
 * Whether an action makes sense on THIS KIND of till — and why not, when it does not.
 *
 * The mirror of `quickKeyAllowedOnSection`, which is about which BAR. This is about the
 * shop: on a hospitality till the floor already lists every open bill, so a "Saved sales"
 * key is a second floor beside the gate — two lists of the same tabs, disagreeing as soon
 * as one goes stale. A retail till has no tables, so the bill and kitchen keys have
 * nothing to act on.
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
     * TWO REASONS A KEY IS RETAIL-ONLY, and one sentence would only ever fit one
     * of them. "The table is the parked basket" answers Saved sales exactly, and
     * answers Quotes with a non-sequitur: nobody was asking about parking.
     *
     * So the ones that are about DOCUMENTS the shop does not write say that
     * instead. The distinction is `retailReason` on the action rather than a
     * second flag, because both still mean the same thing to every caller —
     * hide it — and a second flag would be a second thing to keep in step.
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

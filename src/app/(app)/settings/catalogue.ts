import type { CategoryTone } from '@/components/ui'

/**
 * The system-settings catalogue — the tabs of /settings.
 *
 * This screen exists alongside /setup rather than replacing it, but the two are
 * NOT two doors to the same rooms: a setting lives in exactly one of them.
 * Where /setup is a HUB — tiles that navigate away to a screen each — this is a
 * SHELL: the rail switches a panel in place and the settings themselves live on
 * this one route. That is why a category here carries no href, and why moving a
 * setting in means deleting the setup screen it came from rather than leaving a
 * copy behind.
 *
 * Every tab here is REAL. The screen was first built with a dozen invented
 * categories to settle the layout; those are gone, because a tab that opens on
 * "nothing here yet" teaches people the screen is empty and they stop looking.
 * A category is added to this list at the moment its settings arrive.
 *
 * `blurb` is the one line under the name in the rail; `description` is the
 * longer line the open panel carries under its heading. Two strings because the
 * rail is read at a glance and the panel heading is read to confirm you arrived
 * somewhere useful.
 */

export type SettingsCategory = {
  /** Stable key — also the ?tab= value, so an open panel is linkable. */
  key: string
  label: string
  /** The short line under the name in the rail. */
  blurb: string
  /** The fuller line under the open panel's heading. */
  description: string
  icon: SettingsIconName
  tone: CategoryTone
  /** Search fodder — what somebody types when they don't know the name. */
  keywords: string
  /**
   * The module the shop must have BOUGHT for this tab to exist. Omitted means
   * base package.
   *
   * Carried over from the /setup tiles these settings came from: two of them
   * were gated on `inventory_advanced`, and dropping the gate in the move would
   * have shown a shop settings for a feature it has not bought. As with the
   * menu this hides the TAB only — every panel's load and save actions guard
   * themselves, because a hidden tab is still a `?tab=` somebody can type.
   */
  module?: string
  /**
   * The capability needed to see this tab at all. Omitted means `setup.view`,
   * which the page already checks — so a tab naming nothing here is visible to
   * anyone who can open the screen.
   */
  capability?: string
}

/**
 * The glyphs this catalogue may name.
 *
 * A union rather than a component, because the catalogue is imported by a
 * SERVER component and a Lucide component cannot cross that boundary as a
 * prop — the same reason `hubIcons.tsx` exists for the other three hubs.
 */
export type SettingsIconName =
  | 'Coins'
  | 'Armchair'
  | 'Wallet'
  | 'ClipboardList'
  | 'Terminal'
  | 'Barcode'
  | 'Calendar'
  | 'Code'
  | 'Hash'

export const SETTINGS_CATEGORIES = [
  {
    key: 'purchasing',
    label: 'Purchasing and cost',
    blurb: 'Costing and receiving checks',
    description:
      'How stock is costed, and the checks that run when a delivery is posted.',
    icon: 'Coins',
    tone: 'emerald',
    keywords:
      'cost basis average last cost price landed grv receiving tolerance margin gp purchase order approval threshold',
  },
  {
    key: 'hospitality',
    label: 'Hospitality',
    blurb: 'Service charges and table service',
    description:
      'What a bill is charged on top of the goods, and where that applies.',
    icon: 'Armchair',
    tone: 'orange',
    keywords:
      'tips gratuity service charge tiers waiter pool tables only restaurant sit down bill takeaway',
  },
  {
    key: 'cashup',
    label: 'Cash up',
    blurb: 'Counting and reconciling drawers',
    description:
      'Whether this shop counts a drawer at all, what it is counted against, and how far out it may be before somebody explains it.',
    icon: 'Wallet',
    tone: 'teal',
    keywords:
      'cash up cashup drawer float variance tolerance shift blind count denominations currency notes coins reconcile banking',
  },
  {
    key: 'stock-takes',
    label: 'Stock takes',
    blurb: 'Count variance approvals',
    description:
      'How large a counted difference may be before somebody other than the counter has to explain it.',
    icon: 'ClipboardList',
    tone: 'amber',
    keywords:
      'stock take count variance threshold approval sign off signoff tolerance blind count second signature manager shrinkage difference allowed',
    /* The gate its /setup tile carried. A shop without Advanced Inventory has
       no stock takes to approve. */
    module: 'inventory_advanced',
  },
  {
    key: 'stock-tracking',
    label: 'Stock tracking',
    blurb: 'Lots, expiry and scale labels',
    description: 'Which lot a sale comes from, and how a scale label is read.',
    icon: 'Barcode',
    tone: 'violet',
    keywords:
      'lot batch expiry traceability recall fefo earliest expiry gs1 barcode databar scale plu weighed label capture prompt clerk shelf life best before',
    /* Same gate as its /setup page, which used requireModuleCapability — lot
       capture decides how a feature the shop may not have bought behaves. */
    module: 'inventory_advanced',
  },
  {
    key: 'till',
    label: 'Till',
    blurb: 'How the tills behave',
    description:
      'What every till allows, who may start and stop trading on it, and what it shows before anybody signs in.',
    icon: 'Terminal',
    tone: 'sky',
    keywords:
      'pos point of sale undo void stock warning offline account sales credit clock in sign out logout idle timeout auto lock scan sound beep sign in screen backdrop wallpaper artwork cashier',
  },
  {
    key: 'online-bookings',
    label: 'Online bookings',
    blurb: 'Table bookings and sittings',
    description: 'Whether guests can book a table online, and the times you offer.',
    icon: 'Calendar',
    tone: 'rose',
    keywords:
      'reservations bookings diary online booking form opening hours sittings covers restaurant table seat guest party booking link',
    /* Set by whoever runs the floor rather than whoever configures the shop, so
       this tab carries its own capability instead of riding on setup.view —
       the same guard the page it replaces used. */
    capability: 'reservations.edit',
  },
  {
    key: 'system',
    label: 'System',
    blurb: 'API keys and webhooks',
    description:
      'Keys that let outside programs read this store, and where events get pushed.',
    icon: 'Code',
    tone: 'slate',
    keywords:
      'api keys integration webhooks rest developer tokens external endpoints deliveries machine access openapi',
    /* Standing access with no person behind it, which is why it has always worn
       its own capability rather than riding setup.edit. */
    capability: 'setup.api',
  },
  {
    key: 'decimals',
    label: 'Decimal places',
    blurb: 'Precision on screen',
    description:
      'How many decimals your quantities and costs are shown with. Nothing stored changes — only what you read.',
    icon: 'Hash',
    tone: 'cyan',
    /* The last four came off a settingSearch entry that named this screen and
       duplicated its label; they were folded into the /setup tile and travel
       here with it. Dropping them would make the screen harder to find than it
       was before either move. */
    keywords:
      'decimals decimal places precision rounding quantity qty cost digits display format weight accuracy fractions three four places',
  },
] as const satisfies readonly SettingsCategory[]

/**
 * The tabs one person may see.
 *
 * A tab disappears once the shop has not bought its module, rather than opening
 * on a panel about a feature they do not have. The panels themselves still
 * guard — see the note on `module` above.
 */
export function settingsTabsFor(
  granted: (capability: string) => boolean,
  holds: (module: string) => boolean = () => true,
): SettingsCategory[] {
  /* Widened back to the interface before filtering. `as const` narrows every
     entry to its own literal shape — which is what gives `SettingsTabKey` real
     keys — but that shape omits the optional props entirely on the tabs that do
     not set them, so `c.module` would not typecheck against the union. */
  const all: readonly SettingsCategory[] = SETTINGS_CATEGORIES
  return all.filter(
    (c) => (!c.module || holds(c.module)) && (!c.capability || granted(c.capability)),
  )
}

/**
 * The tab keys, as a union.
 *
 * Derived from the array above rather than typed out, so adding a category
 * gives it a key here for free. `settingSearch.ts` builds `/settings?tab=…`
 * links against this, which makes a renamed or deleted tab a COMPILE error in
 * everything pointing at it rather than a link that silently opens the wrong
 * panel — the same guarantee `SubpageHref` gives the real routes.
 */
export type SettingsTabKey = (typeof SETTINGS_CATEGORIES)[number]['key']

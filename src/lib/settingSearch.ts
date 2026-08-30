import type { SubpageHref } from './nav'

/**
 * The individual SETTINGS inside the setup screens, as one searchable list.
 *
 * `pageSearch.ts` indexes destinations — every screen in the app, by name. This
 * file indexes what those screens DECIDE, one entry per switch, field or panel.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A screen index can only answer a question phrased as a screen name, and
 * nobody knows the screen names. Somebody wanting the till to sign itself out
 * types "auto logout"; the setting is called "Sign out after this long
 * untouched" and lives on a screen called Tills, whose synonyms are "terminals
 * registers pos devices". Nothing about that term touches anything indexed, so
 * the palette returned nothing and the only way left was opening thirty setup
 * screens in turn. That is the failure this list fixes — and it is why the
 * `keywords` here are heavy on the words somebody types when they DON'T know
 * where a setting lives, rather than the words printed on the screen.
 *
 * ── WHY IT IS A SEPARATE LIST ─────────────────────────────────────────────
 *
 * The catalogues carry one line per SCREEN, and nav.ts warns off a second
 * authored string for the same thing. A setting is not the same thing: it is a
 * row inside a screen, with its own name and its own synonyms, and there is
 * nowhere on a hub tile to put it. So this is a new list rather than a fatter
 * catalogue — but it is deliberately NOT a second copy of the screen list, and
 * the test in scripts/test-setting-search.ts holds it to that: every `href`
 * here must be a real screen, and every `anchor` must be an id the screen
 * actually renders.
 *
 * ── WHAT BELONGS HERE ─────────────────────────────────────────────────────
 *
 * A setting somebody would look for BY NAME and struggle to find — a switch, a
 * number, a rule. Not every field on every form: a screen whose whole job is
 * one thing ("Decimals") is already findable as a screen, and duplicating it
 * here just prints the same row twice under two headings.
 */

export type SettingEntry = {
  /** What the setting is called, in the words the screen uses. */
  label: string
  /** The screen it lives on. Must be a real route — the test checks it. */
  href: SubpageHref
  /**
   * The `id` of the element to scroll to and flash, rendered by that screen via
   * <Card id> (see SETTING_ANCHOR in components/ui). Omitted where a screen is
   * small enough that landing on it IS landing on the setting.
   */
  anchor?: string
  /** One line on what it decides — the same job a catalogue description does. */
  description: string
  /**
   * The words somebody TYPES, which are mostly not the words on the screen.
   *
   * Include the plain-English name for the thing ("auto logout"), the words
   * from adjacent products people have used before, and the question form
   * ("how long before"). A synonym here outranks a description in `scorePage`,
   * so this is where a term is made to land deliberately rather than by luck.
   */
  keywords: string
}

export const SETTINGS: SettingEntry[] = [
  /* ── Till behaviour ─────────────────────────────────────────────────────
     The panels on /setup/terminals. The screen is called "Tills" and reads as
     a list of MACHINES, so nothing about its name suggests it also decides how
     those machines behave — which is why every panel here is indexed. */
  {
    label: 'Automatically log out after being idle',
    href: '/setup/terminals',
    anchor: 'idle-logout',
    description:
      'How long a till sits idle before it hands itself back to the PIN pad. Never, or 15 seconds to 5 minutes.',
    keywords:
      'auto logout automatic log out sign out signout logoff idle inactivity timeout time out lock screen autolock auto lock session expire how long before unattended abandoned walk away security pin pad',
  },
  {
    label: 'Return to the PIN pad after every transaction',
    href: '/setup/terminals',
    anchor: 'idle-logout',
    description:
      'Whether the till asks for a PIN again after each sale, so the next one is rung by whoever is standing there.',
    keywords:
      'logout after sale return login pin pad every transaction shared till counter cashier switch user prompt sign in each sale',
  },
  {
    label: 'Force clock in before selling',
    href: '/setup/terminals',
    anchor: 'force-clock-in',
    description: 'Whether a cashier must clock in for a shift before the till will let them sell.',
    keywords:
      'clock in clocking time attendance shift force require must roster timesheet before selling start trading',
  },
  {
    label: 'Scanner sounds',
    href: '/setup/terminals',
    anchor: 'scan-sounds',
    description: 'The beep the till makes when an item scans, and when a scan fails.',
    keywords: 'beep sound audio noise scanner scan volume mute silent chime tone feedback',
  },
  {
    label: 'Account sales while offline',
    href: '/setup/terminals',
    anchor: 'offline-account-sales',
    description:
      'Whether the till may put a sale on a customer account when it cannot reach the server to check their credit.',
    keywords:
      'offline account sales credit limit disconnected no internet network down cannot check risk on account',
  },
  {
    label: 'Sign-in screen artwork',
    href: '/setup/terminals',
    anchor: 'sign-in-art',
    description: 'The backdrop the tills show before anybody signs in.',
    keywords:
      'backdrop background image wallpaper artwork branding logo splash screen idle screen sign in screen looks',
  },

  /* ── Who may do what ───────────────────────────────────────────────────── */
  {
    label: 'PIN codes',
    href: '/setup/users',
    description: 'The number a cashier types to sign in at the till.',
    keywords:
      'pin code passcode number till login change reset forgot cashier clerk staff sign in four digit',
  },
  {
    label: 'Manager override',
    href: '/setup/roles',
    anchor: 'role-permissions',
    description:
      'Which role may approve the things a cashier cannot do alone — a discount, a void, a price change.',
    keywords:
      'override approve authorise authorize supervisor manager permission allow discount void refund price change ask approval who can',
  },

  /* ── Money and pricing ─────────────────────────────────────────────────── */
  {
    label: 'VAT rate',
    href: '/setup/pricing',
    /* Also SELECTS the tab. The VAT list is the second tab, so without this the
       hit landed on Price types with nothing matching what was searched for and
       nothing for the flash to find — an unselected tab renders no panel. The
       screen reads this hash itself; see the effect in PricingClient. */
    anchor: 'vat-rates',
    description: 'The tax rates charged on a sale, and which one a product uses by default.',
    keywords:
      'vat tax rate percentage 15 zero rated exempt gst sales tax change rate charged',
  },
  /* Filed under money because that is what somebody is thinking about, but it
     lives on the NUMBERING screen — cash rounding is a posting rule, sat beside
     the VAT lock, rather than a price rule. That gap between where it reads as
     belonging and where it is built is the whole reason this entry earns its
     place: the obvious guess is Price types & VAT, and it is not there. */
  {
    label: 'Cash rounding',
    href: '/setup/numbering',
    anchor: 'cash-rounding',
    description:
      'How the cash a customer hands over is rounded when coins cannot make the exact amount. Never changes the invoice.',
    keywords:
      'rounding round up down nearest cent 5c 10c cash total swedish rounding smallest coin change drawer price types vat',
  },
  /* No "Decimal places" entry: /setup/decimals is itself called Decimal places,
     so this was a second row with the same words that could never outrank the
     screen. Its extra synonyms (accuracy, fractions, three, four) were folded
     into that screen's catalogue keywords, so nothing stopped being findable. */

  /* ── Documents and printing ────────────────────────────────────────────── */
  {
    label: 'Document numbering',
    href: '/setup/numbering',
    anchor: 'document-numbering',
    description: 'The prefix and next number for invoices, quotes, orders and the rest.',
    keywords:
      'invoice number next number prefix start at sequence counter document numbering reset format autocode',
  },
  {
    label: 'Cash drawer kick',
    href: '/setup/printing',
    description: 'Whether the drawer opens by itself, and on which tenders.',
    keywords:
      'cash drawer open kick pop till drawer automatically when opens money box no sale',
  },
  {
    label: 'Receipt printer',
    href: '/setup/printing',
    description: 'Which printer prints a slip, and how wide it is.',
    keywords:
      'printer receipt slip thermal 80mm 58mm esc pos kitchen bridge print out paper not printing setup printer',
  },
  {
    label: 'Terms on printed documents',
    href: '/setup/stationery',
    anchor: 'document-design',
    description:
      'The layout, logo and footer wording on an invoice, quote or purchase order.',
    keywords:
      'terms conditions footer letterhead logo layout template design banking details bank account on invoice printed wording customise document',
  },

  /* ── Sending things out ────────────────────────────────────────────────── */
  {
    label: 'Outgoing email server',
    href: '/setup/email',
    description: 'The SMTP account this store sends invoices and statements from.',
    keywords:
      'email smtp mail server outgoing send from address port password tls ssl gmail office 365 not sending emails setup email',
  },
  {
    label: 'Low stock alerts',
    href: '/setup/alerts',
    description: 'What the system watches for, and who it tells when it happens.',
    keywords:
      'alert notify notification tell me watch warn low stock reorder automatic rule trigger email whatsapp when stock runs out remind',
  },

  /* ── Stock rules ───────────────────────────────────────────────────────── */
  {
    /* Not on /setup/pricing, where it was filed and where it reads as
       belonging: this is the `price_below_cost` ALERT, set up with the other
       alerts. The old description ("whether the till allows...") promised a
       till guard that screen does not have — same shape of mistake as the
       rounding one, and found the same way. */
    label: 'Selling below cost',
    href: '/setup/alerts',
    description:
      'An alert that finds products priced under cost, or under the margin you set — usually after a cost increase nobody re-priced.',
    keywords:
      'below cost loss making minimum price floor prevent block warn discount too much margin negative gp alert notify pricing',
  },
  {
    label: 'Stock take variance approval',
    href: '/setup/stock-takes',
    description: 'How big a count difference may be before a manager has to sign it off.',
    keywords:
      'stock take count variance threshold approval sign off signoff tolerance blind count second signature manager shrinkage difference allowed',
  },
  {
    label: 'Expiry and batch tracking',
    href: '/setup/stock-tracking',
    description: 'Which products are tracked by lot or expiry date, and when the till asks.',
    keywords:
      'lot batch expiry date traceability recall fefo shelf life best before serial numbers track capture prompt',
  },

  /* ── The shop itself ───────────────────────────────────────────────────── */
  {
    label: 'Store name and VAT number',
    href: '/setup/store-info',
    anchor: 'business-identity',
    description: 'The trading name, address, phone and registration numbers printed on documents.',
    keywords:
      'store name shop company trading name address phone telephone email vat number registration company details letterhead change name my details business information',
  },
  /* No "Trading hours" entry, though there was one and it looked reasonable.
     The SCREEN at /online-store/trading is itself called "Trading hours"
     (SUBPAGE_LABELS in nav.ts), so the entry printed the same words twice in
     one result list — and a screen deliberately outranks a setting on an equal
     score, so the duplicate never won and its anchor never fired. Driving the
     palette showed both rows, which is what a reading of this file could not.
     The `id="trading-hours"` on that card is kept: it costs nothing and the
     screen is three cards deep, so it is there when a setting on it earns its
     own row. See "WHAT BELONGS HERE" at the top. */
]

/**
 * The settings on the screens this user can actually reach.
 *
 * Filtered by ROUTE against the pages already resolved for them, rather than by
 * re-reading capabilities: the page index has resolved what somebody may see
 * once, and a second resolution here is a second thing that can disagree about
 * it. A setting on a screen they cannot open is not a result — it is a locked
 * door with a label on it.
 */
export function visibleSettings(reachable: ReadonlySet<string>): SettingEntry[] {
  return SETTINGS.filter((setting) => reachable.has(setting.href))
}

/**
 * Where a setting hit should navigate — the screen, plus its anchor where it
 * has one, which is what SettingAnchor on the far side reads to flash the panel.
 */
export function settingHref(setting: SettingEntry): string {
  return setting.anchor ? `${setting.href}#${setting.anchor}` : setting.href
}

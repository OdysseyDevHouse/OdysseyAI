import { groupsFor, resolveGroups, type DeclaredGroup, type HubGroup } from '@/lib/hub'
import { SETUP_ELSEWHERE, type SubpageHref } from '@/lib/nav'

/**
 * Every setup screen, grouped by the job it does.
 *
 * This is the ONLY list of the setup screens. The sidebar used to name all of
 * them as well — a flat menu that said nothing about what any of them did, and
 * gave every setting two front doors that could disagree. It is now a single
 * "Setup" link to the hub this file describes, so a new setting is added here
 * and appears in the one place people look.
 *
 * Grouped by WHAT SOMEBODY IS TRYING TO DO — let a person in, decide what a
 * sale costs, get the shop's own details right — and each carries the one line
 * that says what it decides, which is what makes an unfamiliar setting
 * choosable by someone who has not opened it before.
 *
 * Labels come from `SUBPAGE_LABELS` in `src/lib/nav.ts`, which the breadcrumb
 * also reads — so a screen can never be called one thing on its tile and
 * another in the trail above it.
 */

/**
 * A setup route. Narrowed from `SubpageHref` — which names every hub's screens —
 * so a tile pointing at a screen the breadcrumb has never heard of is a compile
 * error.
 *
 * Three kinds of route qualify. Screens under /setup itself; configuration that
 * lives under another section's route but is OWNED here, per `SUBPAGE_OWNER`
 * (pay rules, commission rules); and the screens in `SETUP_ELSEWHERE` —
 * settings this hub lists but leaves in the module that owns them, so their
 * breadcrumb still reads "Online Store › Store setup".
 *
 * Loyalty is no longer one of them. Its programme, tiers and punch cards are
 * menu rows under Loyalty itself, so they are not SUBPAGE_LABELS keys any more
 * and a `/loyalty/${string}` arm here would match nothing.
 */
export type SetupHref =
  | Extract<
      SubpageHref,
      `/setup/${string}` | `/staff/${string}` | '/credit/levels' | '/commission/rules'
    >
  | (typeof SETUP_ELSEWHERE)[number]

const DECLARED: DeclaredGroup<SetupHref>[] = [
  /*
   * FIRST, and deliberately: this is the group a new shop works through before
   * it can trade at all — who we are, where we trade from, what we ring up on,
   * and who may touch it. Everything below decides how the shop WORKS; this
   * decides what the shop IS.
   *
   * The four tiles were scattered across "Users & access" and "Store & stock",
   * which grouped by the shape of the setting rather than by the moment somebody
   * needs it. An owner opening Setup on day one had to visit two groups to
   * finish one job.
   */
  {
    label: 'My store',
    description: 'Who you are, where you trade from, and who may sign in.',
    tone: 'teal',
    icon: 'Store',
    items: [
      /* First in the group, and deliberately: it is the only tile here that
         answers "who are we" rather than "how do we work", and it is the first
         thing a new shop has to get right — every document it prints carries
         these details. */
      {
        href: '/setup/store-info',
        description: 'Your name, address and contact details — and the logo on your documents.',
        keywords:
          'store shop company name trading name address phone telephone email vat number registration number contact details letterhead logo my details business information branding',
        icon: 'Store',
        tone: 'teal',
        capability: 'setup.edit',
      },
      {
        href: '/setup/linked-stores',
        description: 'Branches that share products, customers or loyalty with this one.',
        /* “online” and “storefront” deliberately absent: one shop for the group is
           set up on the online store’s own Setup screen, and a hit here would send
           somebody looking for it to the wrong page. */
        keywords: 'multi store group branches sharing',
        icon: 'Store',
        tone: 'violet',
        capability: 'setup.edit',
        module: 'multi_branch',
      },
      {
        href: '/setup/terminals',
        description: 'Which register rang up a sale, and which machine is which.',
        keywords: 'terminals registers pos devices',
        icon: 'Terminal',
        tone: 'sky',
        capability: 'setup.edit',
      },
      {
        href: '/setup/users',
        description:
          'Who may sign in, at the till and in the back office — and what each role may do.',
        /* Both tiles' synonyms. Roles & permissions is no longer a tile of its
           own — it is a button on the Users screen — so "permissions" and
           "access control" have to land HERE or the search stops finding it. */
        keywords:
          'staff logins pin passwords accounts sales rep roles permissions security capabilities rights access control',
        icon: 'Users',
        tone: 'sky',
        capability: 'setup.users',
      },
      /* Roles & permissions is NOT a tile any more. The SCREEN is unchanged at
         /setup/roles — only its front door moved, onto the Users screen beside
         "Add user". "Who may sign in" and "what they may do" are one job, and
         two tiles for it were two front doors that people had to choose
         between before they knew which they wanted. */
    ],
  },
  /*
   * Renamed from "Users & access", which stopped describing it.
   *
   * Users, roles and the API key screen all left — the first two to "My store"
   * above, the third to /settings. What remained was four tiles about what
   * people COST: pay rules, leave entitlement, cost per employee and commission.
   * That is a different question, asked by a different person on a different
   * day, so the heading now says so.
   */
  {
    label: 'Pay & commission',
    description: 'What an hour is worth, what leave grants, and who earns on a sale.',
    tone: 'sky',
    icon: 'Coins',
    items: [
      /* The audit trail is NOT here any more — it is in the reports catalogue,
         under Operations. It was the one tile in this hub that answered a
         question rather than deciding something, and "who changed this price"
         is asked at the reports screen. The route is unchanged; only where it
         is listed moved. See `/reports` and `AUDIT_HREF` in nav.ts. */
      /* API & webhooks is NOT here any more — it moved to /settings under the
         "System" tab, where the machine-facing configuration belongs. */
      /* Pay rules and cost sit with people rather than under Staff: both are
         configuration that decides what every figure on the staff screens comes
         to, and neither is opened in the course of a normal week. */
      {
        href: '/staff/pay-rules',
        description: 'Overtime, Sundays and public holidays — what an hour is worth.',
        keywords: 'overtime rates wages salary hourly bcea holidays',
        icon: 'Percent',
        tone: 'amber',
        capability: 'staff.cost',
        /* Goes with the Staff section. A shop that has switched that off should
           not be left configuring pay rules for rows it cannot see. */
        menuArea: 'staff',
      },
      /* Leave entitlement is configuration for the same reason pay rules are:
         it decides what every balance on the leave screen comes to, and it is
         set once rather than touched in a normal week. */
      {
        href: '/staff/leave-types',
        description: 'Annual, sick and family leave — how many days each grants, and how they arrive.',
        keywords: 'leave days annual sick family maternity unpaid entitlement accrual bcea holiday allowance',
        icon: 'Clock',
        tone: 'sky',
        capability: 'staff.edit',
        menuArea: 'staff',
      },
      {
        href: '/staff/cost',
        description: 'What each employee costs the business, once the rules are applied.',
        keywords: 'wages salary labour cost payroll per employee',
        icon: 'Coins',
        tone: 'emerald',
        capability: 'staff.cost',
        menuArea: 'staff',
      },
      /* The other half of what a person is paid, and until now reachable only
         from /commission by somebody who already knew it was there. */
      {
        href: '/commission/rules',
        description: 'Who earns commission, on what they sell, and at what rate.',
        keywords: 'commission rates rules percentage sales rep earnings targets',
        icon: 'Percent',
        tone: 'rose',
        capability: 'commission.edit',
        menuArea: 'staff',
      },
    ],
  },
  {
    label: 'Money & pricing',
    description: 'What a line costs, and how a sale can be paid for.',
    tone: 'emerald',
    icon: 'Coins',
    items: [
      /*
       * TWO TILES, ONE SCREEN.
       *
       * /setup/pricing is a tabbed screen — price types on one tab, VAT rates on
       * the other — and it stays that way: they share a save, and setting up a
       * wholesale tier while the rate it charges lives on another route is the
       * arrangement that screen exists to avoid.
       *
       * But they are looked for separately. "Add a wholesale price" and "change
       * the VAT rate" are different errands, asked by different people in
       * different months, and one tile named for both was a tile named for
       * neither. The second carries `anchor: 'vat-rates'`, which the screen
       * already reads to open its VAT tab — see the hash effect in
       * PricingClient. Both tiles need `label`, since the route's own name
       * ("Price types & VAT") describes the whole screen rather than either half.
       */
      {
        href: '/setup/pricing',
        label: 'Price types',
        description: 'Retail, wholesale and the tiers a product can carry — plus bulk repricing.',
        keywords: 'price structures tiers retail wholesale markup reprice repricing margin',
        icon: 'Tag',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/pricing',
        anchor: 'vat-rates',
        label: 'VAT rates',
        description: 'The tax rates charged on a sale, and which one a product uses by default.',
        /* Carries the words somebody TYPES, not just the ones on the screen —
           "15", "zero rated", "gst", "sales tax". They came from a settingSearch
           entry for "VAT rate" that pointed at this same anchor; this tile
           replaced it, and dropping its synonyms would have made the rate harder
           to find than before the split. */
        keywords:
          'vat tax rate rates percentage 15 zero rated exempt gst sales tax sars change rate charged standard rate',
        icon: 'Percent',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      /* Purchasing & cost is NOT here any more — it moved to /settings, the
         system-settings screen, under its "Purchasing and cost" tab. It used to
         sit beside Pricing as the other half of one sentence (that tile is what
         a product SELLS for, this was what it is HELD at); the two are now on
         different screens, which is the cost of that move. */
      {
        href: '/setup/tender-types',
        description: 'How sales are paid for. Some stores have four, some have ten.',
        keywords: 'cash card eft payment methods vouchers',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      /* Beside the tender types, because they answer the same question from two
         ends: what a cashier may take at the counter, and what a customer may
         pay from an email or a printed square. Moved here from the online store,
         where the MODULE gate meant a shop without a storefront could not
         connect a gateway — and therefore never got a pay link on an invoice. */
      {
        href: '/setup/payments',
        description: 'The account that takes online payments — pay links on invoices and statements, and the storefront checkout.',
        keywords:
          'payfast gateway online payments pay link qr code invoice statement layby deposit card eft checkout merchant sandbox',
        // Landmark — a bank. CreditCard is the tender-types tile directly above,
        // and two identical glyphs side by side read as one repeated entry.
        icon: 'Landmark',
        tone: 'sky',
        capability: 'setup.edit',
      },
      /* Cash-up is NOT here any more — it moved to /settings, under the
         "Cash up" tab. */
      /* Tips is NOT here any more — it moved to /settings, under the
         "Hospitality" tab, which is where service charges and the rest of
         table service now live. */
      {
        href: '/setup/laybys',
        description: 'What a customer agrees to when they put something aside.',
        keywords: 'deposit cancellation fee terms instalments',
        icon: 'Package',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/credit/levels',
        description: 'How much credit a customer may take, and when they are stopped.',
        keywords: 'credit limit terms account hold blocked risk',
        icon: 'ShieldCheck',
        tone: 'rose',
        capability: 'customers.credit',
        module: 'customers',
      },
      /* Beside the credit ladder because both answer "what terms does this
         account trade on" — this one sets where a NEW account starts, that one
         decides when an existing one is stopped. */
      {
        href: '/setup/customer-groups',
        description: 'The terms and price structure a new account starts on — wholesale, retail, staff.',
        keywords: 'customer groups categories wholesale retail staff trade terms price structure defaults segment',
        icon: 'Users',
        tone: 'sky',
        capability: 'setup.edit',
        module: 'customers',
      },
      {
        href: '/setup/expense-categories',
        description: 'What the business spends on, and where each one posts in the ledger.',
        keywords: 'chart of accounts spending overheads account codes',
        icon: 'Scale',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/opening-balances',
        description: 'Carry in what is already owed on the day you switch over.',
        keywords: 'import migration debtors creditors go live',
        icon: 'FileText',
        tone: 'orange',
        capability: 'setup.edit',
      },
      {
        href: '/setup/import',
        description: 'Bring a catalogue, a debtors list or a supplier book in from a spreadsheet.',
        keywords: 'csv xlsx excel spreadsheet upload bulk load migrate products customers suppliers departments',
        icon: 'Boxes',
        tone: 'indigo',
        // The tile is only a door: each import guards itself with the
        // capability of the thing it writes, and the index filters to those.
        capability: 'setup.view',
      },
    ],
  },
  {
    label: 'Store & stock',
    description: 'The shop itself — its tills, its stock rooms, its branches.',
    tone: 'teal',
    icon: 'Store',
    items: [
      /* My store information is NOT here any more — it leads the "My store"
         group at the top, which is where a new shop starts. This group keeps
         what the shop HOLDS rather than what it IS. */
      {
        href: '/setup/locations',
        description: 'The places stock is kept. Sales come from the main one.',
        keywords: 'warehouse storeroom bins branches',
        icon: 'Warehouse',
        tone: 'teal',
        capability: 'setup.edit',
        module: 'inventory_advanced',
      },
      /* One tile for all three lists — stock adjustments, voids and returns.
         They were two tiles a row apart, which meant somebody looking for
         "reasons" had to know which of the two they wanted before they could
         find either. No `module`: the void and return lists belong to every
         shop, and the screen shows the adjustments tab only where the inventory
         module is actually held. */
      {
        href: '/setup/reasons',
        description:
          'Why stock was written on or off, why a sale was cancelled, and why goods came back.',
        keywords:
          'write off shrinkage damage breakage wastage expired void cancel refund return credit note faulty codes exception',
        icon: 'SlidersHorizontal',
        tone: 'teal',
        capability: 'setup.edit',
      },
      /* Stock take approvals and Stock tracking are NOT here any more — both
         moved to /settings, under their own "Stock takes" and "Stock tracking"
         tabs. They used to sit here beside Reasons, which is the vocabulary a
         variance is explained IN; that tile stays, and the two halves of the
         sentence are now on different screens.

         NOTE: both tiles carried `module: 'inventory_advanced'`, which the
         settings shell does not yet apply to its tabs. See the settings
         catalogue. */
      /* Tills is NOT here any more — it moved to the "My store" group at the
         top, beside the shop's own details: what you ring up on is part of what
         the shop IS. The two tiles below still refer to it as their neighbour
         because they answer the same question it does — what a till SHOWS. */
      /* Beside Tills and Rotating menus, which is the company it keeps: all
         three decide what a till SHOWS rather than what it sells. It was a
         sidebar row under Sales on the argument that a quick key gets changed
         because of what happened at the till — true, but the screen needs
         `setup.edit`, which the people serving on a till mostly do not have.
         Menu designer is still NOT here: it stays a row under Products, beside
         the product file it arranges, so it remains out of SUBPAGE_LABELS and
         `SetupHref` does not admit it. */
      {
        href: '/setup/quick-keys',
        description: 'The buttons on the till — the things this shop sells most.',
        keywords:
          'quick keys buttons tiles favourites shortcuts till pos grid bar hot keys speed keys top sellers',
        icon: 'LayoutGrid',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/setup/pos-menus',
        description: 'Breakfast, lunch and dinner — the till switches by the clock.',
        keywords:
          'rotating menus breakfast lunch dinner day part daypart time of day service hours schedule till pos grid',
        icon: 'Clock',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/tables',
        description: 'The floor a waiter sees — and whether the till shows it at all.',
        keywords: 'tables restaurant hospitality floor sections covers waiter bills',
        icon: 'LayoutGrid',
        tone: 'amber',
        capability: 'setup.edit',
      },
      /* Reservations is NOT here any more — it moved to /settings under the
         "Online bookings" tab, and was renamed with the move: every heading on
         the screen already said bookings, and "reservation" separately names
         the stock a job card claims. It used to sit beside Tables, which is the
         floor a booking is matched against; that tile stays. */

      /* Linked stores is NOT here any more — it moved to the "My store" group
         at the top, beside this shop's own details: which branches you trade
         with is part of who you are, not of how the floor works. */
    ],
  },
  /*
   * The group below is a CROSS-REFERENCE — every tile in it opens a screen
   * this hub does not own, listed here because this is where somebody looks
   * for a setting. Its breadcrumbs still read "Accounting › …", which is why
   * those screens are not in `SUBPAGE_OWNER`. See `SETUP_ELSEWHERE` in
   * src/lib/nav.ts for why being in two hubs is safe.
   *
   * The online store's own switches are NOT here any more: that section now
   * carries a Setup row of its own, so listing them here as well would be the
   * second front door this file exists to avoid.
   *
   * Each `capability` mirrors the guard on the page itself — checked against
   * the real `requireCapability` call, not guessed, because a tile gated on a
   * capability the page does not use hides a screen from somebody who can
   * open it.
   */
  {
    label: 'Accounting & posting',
    description: 'Where figures land in the ledger, and when the books are closed.',
    tone: 'indigo',
    icon: 'Scale',
    items: [
      {
        href: '/accounting/accounts',
        description: 'The ledger accounts everything posts to, and what each is for.',
        keywords: 'chart of accounts ledger codes general ledger',
        icon: 'Landmark',
        tone: 'indigo',
        capability: 'reports.financial',
      },
      {
        href: '/accounting/periods',
        description: 'Close a month so nobody can post into it after the fact.',
        keywords: 'period lock close month year end freeze',
        icon: 'Lock',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/expenses/recurring',
        description: 'Rent, subscriptions — the costs that repeat without being asked.',
        keywords: 'standing order repeating monthly rent subscription',
        icon: 'Repeat',
        tone: 'violet',
        capability: 'cashbook.edit',
      },
      /* Scheduled reports is NOT here any more. The SCREEN is unchanged and
         still lives at /reports/schedules — only this tile went, because it is
         reached from the reports hub's own "Schedule a report" button beside
         "Build a report". A scheduled report is something you make where the
         reports are, not a setting you configure once. */
    ],
  },
  {
    label: 'System',
    description: 'The plumbing — document numbers, databases, and whether it all adds up.',
    tone: 'slate',
    icon: 'Settings',
    items: [
      {
        href: '/setup/numbering',
        description: 'The prefixes and next numbers for invoices, quotes and codes.',
        keywords: 'sequences document numbers prefix autocode',
        icon: 'Hash',
        tone: 'slate',
        capability: 'setup.edit',
      },
      {
        /* Beside numbering: both shape how the app PRESENTS itself rather than
           what it does, and neither changes a stored figure. */
        href: '/setup/decimals',
        description: 'How many decimals your quantities and costs are shown with.',
        /* The last four came off a settingSearch entry that named this screen
           and duplicated its label, printing the same row twice. Folded in here
           rather than dropped with it. */
        keywords:
          'decimals decimal places precision rounding quantity qty cost digits display format weight accuracy fractions three four places',
        icon: 'Hash',
        tone: 'slate',
        capability: 'setup.edit',
      },
      {
        /* Under System rather than under Jobs, because it is not a job feature:
           the same mechanism serves jobs, customers and equipment, and filing it
           beside the job workflow would be the first step towards it becoming
           job-shaped. */
        href: '/setup/custom-fields',
        description: 'Extra fields of your own on jobs, customers and equipment.',
        keywords: 'custom fields extra user defined attributes metadata bespoke',
        icon: 'Tag',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/setup/reconciliation',
        description: 'Does the system still add up? Stock, balances and document numbers.',
        keywords: 'drift integrity check invariants audit',
        icon: 'Check',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/training',
        description: 'Let someone practise on the real system, then remove everything they did.',
        keywords: 'training practice demo test sandbox learn staff dummy trial reset clear',
        icon: 'GraduationCap',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/databases',
        description: 'This shop’s details, and the health of every database behind it.',
        keywords: 'connection health server site details',
        icon: 'Database',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        href: '/setup/billing',
        description: 'The modules this store pays for, and what the account is charged.',
        keywords:
          'plan subscription modules upgrade downgrade invoice licence licences price cost add-on billing account debit order',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        /*
         * Directly after billing, because the two are the same subject asked one
         * step apart: what this shop PAYS for, and what it wants to LOOK at. A
         * shop that has just read its plan is exactly the reader who wants to
         * put half of it away.
         *
         * Deliberately carries NO `module`. Every other tile here can be filtered
         * out of the hub; this one must never be, or a shop that hides a module
         * loses the screen that would bring it back.
         */
        href: '/setup/modules',
        description: 'Switch off the parts of the system this shop does not use, so they leave the menu.',
        keywords:
          'menu modules hide show sidebar navigation simplify remove sections turn off disable job cards loyalty online store accounting customers declutter tidy',
        icon: 'LayoutGrid',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        /* Beside SMS because they are the same question asked of a different
           channel: how does this shop reach somebody. Email first — every
           document the business sends leaves through it. */
        href: '/setup/email',
        description: 'The mail account your invoices, statements and orders are sent from.',
        keywords:
          'email smtp mail server outgoing send from address port password tls ssl gmail office 365 test message',
        icon: 'Mail',
        tone: 'sky',
        capability: 'setup.edit',
      },
      {
        href: '/setup/sms',
        description: 'How this shop reaches people on their phone, and the reminders that use it.',
        keywords: 'sms text message smsportal whatsapp meta reminders dunning notify phone mobile',
        icon: 'MessageSquare',
        tone: 'sky',
        capability: 'setup.edit',
      },
      {
        /* After email and SMS because it is the same subject from the other
           side: those are how the shop reaches a customer, this is how a
           customer reaches their own account without ringing anybody. It also
           NEEDS email configured to work at all — sign-in is a mailed link —
           so it reads in the right order. */
        href: '/setup/customer-portal',
        description: 'Let customers sign in to see their own details, transactions and statement.',
        keywords:
          'customer portal account statement online self service my account link transactions history invoices pay online debtors login sign in',
        icon: 'Users',
        tone: 'violet',
        capability: 'setup.edit',
        module: 'customers',
      },
      {
        href: '/setup/alerts',
        description: 'Watch for something, tell the right people, and offer the fix.',
        keywords:
          'alert automation notify watch warn tell me email whatsapp low stock reorder automatic rule trigger',
        icon: 'Bell',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/printing',
        description: 'The slip’s footer, and the thermal printer plugged into each till.',
        keywords: 'receipt printer thermal esc pos slip 80mm cash drawer kick kitchen bridge print',
        icon: 'Receipt',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/stationery',
        description: 'How printed documents are laid out — your letterhead, columns and wording.',
        keywords:
          'stationery template design document layout letterhead logo purchase order invoice quote print custom html branding terms footer unit cost columns',
        icon: 'FileText',
        tone: 'amber',
        capability: 'setup.stationery',
      },
      {
        href: '/setup/style-guide',
        description: 'Every component the app is built from, rendered live.',
        keywords: 'design system components reference ui kit',
        icon: 'Palette',
        tone: 'rose',
        capability: 'setup.view',
      },
    ],
  },
]

/**
 * The screens that exist only on a developer's machine.
 *
 * Site & databases prints server hostnames, database names and usernames; the
 * Style Guide is the design system's own reference. Neither means anything to a
 * shop, and both routes now `notFound()` outside a dev build — see `isDevBuild`
 * in lib/auth.ts, which explains why NODE_ENV is the authority and why there is
 * no flag to turn them back on.
 *
 * Filtered out of the catalogue rather than off the hub, because the catalogue
 * is read by the global SEARCH as well: leaving them here would offer a shop
 * two results that 404, which is worse than not finding them.
 */
export const DEV_ONLY_ROUTES: ReadonlySet<string> = new Set([
  '/setup/databases',
  '/setup/style-guide',
])

export const SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)
  .map((group) =>
    process.env.NODE_ENV === 'production'
      ? { ...group, items: group.items.filter((item) => !DEV_ONLY_ROUTES.has(item.href)) }
      : group,
  )
  /* A group emptied by that filter would render as a heading over nothing. None
     is today — both tiles share their groups — but a heading over an empty
     group is exactly the broken-looking screen groupsFor already guards. */
  .filter((group) => group.items.length > 0)

/** The whole catalogue flat — for searching and counting. */
export const SETUP_ITEMS = SETUP_GROUPS.flatMap((g) => g.items)

/** The catalogue as one user sees it — empty groups dropped. */
export function setupGroupsFor(
  granted: (capability: string) => boolean,
  holds: (module: string) => boolean = () => true,
  /** Areas switched off under Setup → Menu & modules — the staff tiles use it. */
  menuHidden: (area: string) => boolean = () => false,
): HubGroup[] {
  return groupsFor(SETUP_GROUPS, granted, holds, menuHidden)
}

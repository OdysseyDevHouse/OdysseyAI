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
 * (pay rules, commission rules, the loyalty programme); and the screens in
 * `SETUP_ELSEWHERE` — settings this hub lists but leaves in the module that
 * owns them, so their breadcrumb still reads "Online Store › Store setup".
 */
export type SetupHref =
  | Extract<
      SubpageHref,
      | `/setup/${string}`
      | `/staff/${string}`
      | '/credit/levels'
      | '/commission/rules'
      | `/loyalty/${string}`
    >
  | (typeof SETUP_ELSEWHERE)[number]

const DECLARED: DeclaredGroup<SetupHref>[] = [
  {
    label: 'People & access',
    description: 'Who may sign in, what they are allowed to do, and what they are paid.',
    tone: 'sky',
    icon: 'ShieldCheck',
    items: [
      {
        href: '/setup/users',
        description: 'Who may sign in, at the till and in the back office.',
        keywords: 'staff logins pin passwords accounts sales rep',
        icon: 'Users',
        tone: 'sky',
        capability: 'setup.users',
      },
      {
        href: '/setup/roles',
        description: 'What each role may do — name them after the jobs people actually do.',
        keywords: 'security capabilities rights access control',
        icon: 'KeyRound',
        tone: 'indigo',
        capability: 'setup.users',
      },
      {
        href: '/setup/audit',
        description: 'Every change anyone made, and who signed in when.',
        keywords: 'audit log history who changed sign in login security trail',
        icon: 'History',
        tone: 'sky',
        capability: 'setup.audit',
      },
      {
        href: '/setup/api',
        description: 'Keys that let outside programs read this store, and where events get pushed.',
        keywords: 'integration rest developer tokens external webhooks deliveries',
        icon: 'Terminal',
        tone: 'violet',
        capability: 'setup.api',
      },
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
      },
      {
        href: '/staff/cost',
        description: 'What each employee costs the business, once the rules are applied.',
        keywords: 'wages salary labour cost payroll per employee',
        icon: 'Coins',
        tone: 'emerald',
        capability: 'staff.cost',
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
      },
    ],
  },
  {
    label: 'Money & pricing',
    description: 'What a line costs, and how a sale can be paid for.',
    tone: 'emerald',
    icon: 'Coins',
    items: [
      {
        href: '/setup/pricing',
        description: 'Retail, wholesale and the rates they charge — plus bulk repricing.',
        keywords: 'tax rates price structures markup reprice vat',
        icon: 'Percent',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      /* Beside Pricing because they are two halves of one sentence: that tile is
         what a product SELLS for, this is what it is HELD at. Both feed the same
         margin, which is why neither belongs under Store & stock with the
         warehouses. */
      {
        href: '/setup/purchasing',
        description: 'Average or last cost, and the checks that run when a delivery is posted.',
        keywords: 'cost basis average last cost price landed grv receiving tolerance margin gp',
        icon: 'Coins',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/tender-types',
        description: 'How sales are paid for. Some stores have four, some have ten.',
        keywords: 'cash card eft payment methods vouchers',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'setup.edit',
      },
      {
        href: '/setup/cashup',
        description: 'What a drawer is counted against, and how far out it may be before somebody explains it.',
        keywords: 'cashup cash up drawer variance tolerance shortage over short till float shift blind count reconcile',
        icon: 'Coins',
        tone: 'emerald',
        capability: 'setup.edit',
      },
      {
        href: '/setup/tips',
        description: 'Service charges by bill size, and whether they apply off the floor.',
        keywords: 'tips gratuity service charge tiers waiter pool',
        /* `Percent` from the hub's own icon union — `HandCoins` exists in the kit but not in
           `HubIconName`, which is a deliberately short list so a hub tile cannot name a
           glyph the hub cannot render. A service charge is a percentage, so this reads
           correctly rather than being a substitute. */
        icon: 'Percent',
        tone: 'amber',
        capability: 'setup.edit',
      },
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
      {
        href: '/setup/locations',
        description: 'The places stock is kept. Sales come from the main one.',
        keywords: 'warehouse storeroom bins branches',
        icon: 'Warehouse',
        tone: 'teal',
        capability: 'setup.edit',
        module: 'inventory_advanced',
      },
      {
        href: '/setup/adjustment-reasons',
        description: 'Why stock was written on or off. What a loss report groups by.',
        keywords: 'write off shrinkage damage breakage wastage expired codes',
        icon: 'SlidersHorizontal',
        tone: 'teal',
        capability: 'setup.edit',
        module: 'inventory_advanced',
      },
      {
        href: '/setup/sales-reasons',
        description: 'Why a sale was cancelled, and why goods came back.',
        keywords: 'void cancel reasons refund return credit note faulty codes exception',
        icon: 'SlidersHorizontal',
        tone: 'rose',
        capability: 'setup.edit',
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
        href: '/setup/quick-keys',
        description: 'The buttons on the till — the things this shop sells most.',
        keywords: 'quick keys buttons tiles favourites shortcuts till pos grid',
        icon: 'LayoutGrid',
        tone: 'violet',
        capability: 'setup.edit',
      },
      {
        href: '/setup/menu-designer',
        description: 'The till’s browse menu — departments and products, in the order they appear.',
        /* No "arrange" here, deliberately: every SUBSTRING of a keyword matches,
           so it makes this screen a hit for "rang" — and "rang up" is how
           somebody looks for the Tills screen. */
        keywords:
          'menu designer browse grid departments categories order sort drag tiles till pos catalogue',
        icon: 'LayoutGrid',
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
      {
        href: '/setup/reservations',
        description: 'Whether the floor takes bookings, and the hours it takes them for.',
        keywords: 'reservations bookings diary online booking form opening hours sittings covers restaurant',
        icon: 'Clock',
        tone: 'amber',
        capability: 'setup.edit',
      },
      {
        href: '/setup/job-workflow',
        description: 'The stages a job moves through, and the boards that show them.',
        keywords: 'job card workflow statuses stages board kanban columns service repair technician',
        icon: 'Wrench',
        tone: 'amber',
        capability: 'jobs.setup',
        module: 'job_cards',
      },
      {
        /* Beside job workflow, because the two are the same kind of decision
           for two different teams. Its own tile rather than a panel there:
           `tickets.setup` is a separate capability, so somebody who configures
           the support desk may well not configure the field one. */
        href: '/setup/tickets',
        description: 'The lanes on the ticket board, and what each one does to the clock.',
        keywords: 'ticket support helpdesk lanes columns kanban clock timer running limit',
        icon: 'Ticket',
        tone: 'amber',
        capability: 'tickets.setup',
      },
      {
        href: '/setup/linked-stores',
        description: 'Branches that share products, customers or loyalty with this one.',
        keywords: 'multi store group branches sharing',
        icon: 'Store',
        tone: 'violet',
        capability: 'setup.edit',
        module: 'multi_branch',
      },
    ],
  },
  {
    /* Loyalty's own settings, which used to be three of the four rows in a
       top-level Loyalty menu section. The members list stays in the menu under
       Customers, because that is the screen somebody actually opens; these three
       decide how the programme works and are set once. */
    label: 'Loyalty',
    description: 'How the programme rewards people, and what a point is worth.',
    tone: 'violet',
    icon: 'Gem',
    items: [
      {
        href: '/loyalty/programme',
        description: 'Whether points are earned, at what rate, and what they redeem for.',
        keywords: 'points rewards earn rate redemption programme rules',
        icon: 'Settings',
        tone: 'violet',
        capability: 'loyalty.view',
        module: 'loyalty',
      },
      {
        href: '/loyalty/tiers',
        description: 'Bronze, silver, gold — what it takes to get there and what it gives.',
        keywords: 'tiers levels vip bronze silver gold status benefits',
        icon: 'Gem',
        tone: 'amber',
        capability: 'loyalty.view',
        module: 'loyalty',
      },
      {
        href: '/loyalty/cards',
        description: 'Buy nine, get the tenth free — punch cards and what fills them.',
        keywords: 'punch card stamps buy x get y free coffee',
        icon: 'Stamp',
        tone: 'orange',
        capability: 'loyalty.view',
        module: 'loyalty',
      },
    ],
  },
  /*
   * The two groups below are CROSS-REFERENCES — every tile in them opens a
   * screen this hub does not own, listed here because this is where somebody
   * looks for a setting. Their breadcrumbs still read "Online Store › …" and
   * "Accounting › …", which is why they are not in `SUBPAGE_OWNER`. See
   * `SETUP_ELSEWHERE` in src/lib/nav.ts for why being in two hubs is safe.
   *
   * Each `capability` mirrors the guard on the page itself — checked against
   * the real `requireCapability` call, not guessed, because a tile gated on a
   * capability the page does not use hides a screen from somebody who can
   * open it.
   */
  {
    label: 'Selling online',
    description: 'The web shop’s own switches — kept with the store, listed here too.',
    tone: 'sky',
    icon: 'ShoppingBag',
    items: [
      {
        href: '/online-store/setup',
        description: 'The name, the domain, delivery charges, and whether the shop is live.',
        keywords: 'domain url delivery fees shipping open closed launch go live web shop',
        icon: 'Settings',
        tone: 'sky',
        capability: 'online.edit',
      },
      {
        href: '/online-store/payments',
        description: 'How shoppers may pay, and the gateway that takes the money.',
        keywords: 'payfast yoco ozow gateway card eft checkout',
        icon: 'CreditCard',
        tone: 'indigo',
        capability: 'online.edit',
      },
      {
        href: '/online-store/statuses',
        description: 'The steps an order moves through, from paid to collected.',
        keywords: 'workflow stages pipeline packing shipped fulfilment',
        icon: 'ListOrdered',
        tone: 'teal',
        capability: 'online.edit',
      },
      {
        href: '/online-store/discounts',
        description: 'Codes a shopper can type at checkout, and what each takes off.',
        keywords: 'promo coupon voucher promotion sale code',
        icon: 'Tag',
        tone: 'rose',
        capability: 'online.edit',
      },
    ],
  },
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
      {
        href: '/reports/schedules',
        description: 'Reports that email themselves — to whom, and how often.',
        keywords: 'scheduled email me automatic recurring report delivery',
        icon: 'Mail',
        tone: 'emerald',
        capability: 'reports.schedule',
      },
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
        href: '/setup/sms',
        description: 'The provider that sends text messages, and the reminders that use it.',
        keywords: 'sms text message smsportal reminders dunning notify phone mobile',
        icon: 'MessageSquare',
        tone: 'sky',
        capability: 'setup.edit',
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

export const SETUP_GROUPS: HubGroup[] = resolveGroups(DECLARED)

/** The whole catalogue flat — for searching and counting. */
export const SETUP_ITEMS = SETUP_GROUPS.flatMap((g) => g.items)

/** The catalogue as one user sees it — empty groups dropped. */
export function setupGroupsFor(
  granted: (capability: string) => boolean,
  holds: (module: string) => boolean = () => true,
): HubGroup[] {
  return groupsFor(SETUP_GROUPS, granted, holds)
}

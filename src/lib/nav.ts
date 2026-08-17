import {
  Home,
  LineChart,
  Table,
  Boxes,
  LayoutGrid,
  ClipboardList,
  PackageOpen,
  ArrowLeftRight,
  Tag,
  CalendarClock,
  Lightbulb,
  Factory,
  Contact,
  Package,
  PieChart,
  Settings,
  ShoppingBag,
  Gem,
  Gift,
  Plus,
  FileText,
  Users,
  Undo2 as Reverse,
  ListOrdered,
  ChartColumn as BarChart,
  Mail,
  Truck,
  Coins,
  HandCoins,
  Scale,
  SlidersHorizontal,
  Percent,
  Bell,
  Clock,
  CalendarRange,
  Handshake,
  Repeat,
  Ticket,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

/**
 * The single description of the application's navigation.
 *
 * Both the sidebar and the breadcrumb read from here, so a renamed section can
 * never show one label in the menu and a different one in the trail.
 *
 * `built: false` marks a destination that is planned but has no route yet. It
 * is rendered, greyed and unclickable, rather than linked — a link to a page
 * that 404s is worse than an obviously-not-ready one.
 */

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  built?: boolean
  /**
   * What a user must hold to see this. Omitted means everyone signed in.
   *
   * This hides the menu entry only. It is NOT the security boundary — the page
   * and any server action behind it check for themselves, because a hidden
   * link is still a URL anyone can type.
   */
  capability?: string
  /**
   * The module the shop must have BOUGHT for this to exist. Omitted means it is
   * part of the base package everybody gets.
   *
   * A different question from `capability`, which asks what this PERSON may do.
   * Both are filtered here, and — as above — neither is the security boundary.
   */
  module?: string
  /** Words someone might search for that are not in the label. */
  keywords?: string
  /**
   * What the screen does, in one line — shown under its name in the global
   * search palette.
   *
   * The menu itself never renders this; a sidebar row is a word, not a sentence.
   * It exists because a search RESULT has to be choosable by somebody who has
   * not opened the screen before, and a bare label often is not: "Collections"
   * and "Promises to pay" mean nothing until you know they are about chasing
   * overdue accounts. The hub screens get this from their catalogue, which is
   * where a hub's own tiles read it; a menu item has no catalogue, so it says so
   * here.
   */
  description?: string
}

export type NavSection = {
  label: string
  icon: LucideIcon
  /** A section with no children is a link in its own right. */
  href?: string
  items?: NavItem[]
  built?: boolean
  capability?: string
  /** As on NavItem — the module the shop must hold for this to exist. */
  module?: string
  /** As on NavItem — one line for the search palette, never for the menu. */
  description?: string
  /**
   * Search synonyms for the section itself. Matters most for a hub, whose
   * screens the menu no longer names: without these, collapsing a dozen rows
   * into one link makes the search box worse than it was.
   */
  keywords?: string
}

export const NAV: NavSection[] = [
  { label: 'Dashboard', icon: Home, href: '/dashboard', built: true, capability: 'dashboard.view', description: 'How the shop is trading today' },
  {
    label: 'Sales',
    icon: LineChart,
    items: [
      { label: 'Point of sale', href: '/pos', icon: Plus, built: true, capability: 'sales.till', description: 'Open the till and serve a customer' },
      /* One row, not two. Invoicing was the capture worklist and Documents the
         finalised record — the same table under two addresses, where finding an
         invoice meant knowing which of the two it had moved to. Status is a
         filter on this screen now, and /sales redirects here. */
      { label: 'Invoicing', href: '/invoicing', icon: FileText, built: true, capability: 'sales.view', keywords: 'documents invoice credit note receipt tax sale history', description: 'Every invoice and credit note, from draft to finalised' },
      { label: 'Orders', href: '/invoicing/orders', icon: ListOrdered, built: true, capability: 'sales.view', description: 'What customers have ordered but not yet taken' },
      { label: 'Quotes', href: '/invoicing/quotes', icon: FileText, built: true, capability: 'sales.view', description: 'Prices offered, and what became of them' },
      { label: 'Lay-bys', href: '/invoicing/laybys', icon: Package, built: true, capability: 'sales.view', description: 'Goods put aside and paid off over time' },
      { label: 'Reservations', href: '/sales/reservations', icon: CalendarClock, built: true, capability: 'reservations.view', keywords: 'bookings table diary covers restaurant seating guests', description: 'Tonight’s book — who is coming and where they sit' },
      { label: 'Contracts', href: '/sales/contracts', icon: Repeat, built: true, capability: 'contracts.view', description: 'Agreements that bill themselves on a schedule' },
      { label: 'Returns', href: '/sales/returns', icon: Reverse, built: true, capability: 'sales.credit_note', description: 'Take goods back and credit the customer' },
      { label: 'Cash-up', href: '/sales/cashup', icon: Coins, built: true, capability: 'sales.cashup', description: 'Count a drawer and close off a shift' },
      /* Paying tips out, beside the cash-up rather than under Setup: it happens at the end
         of a shift, by whoever counts the drawer, and shares that capability. Setup → Tips
         is the other half — what a bill is CHARGED, which is configuration. */
      { label: 'Tips', href: '/sales/tips', icon: HandCoins, built: true, capability: 'sales.cashup', description: 'What was collected, and paying it out to staff' },
      /* Offline sales is NOT here any more — it is a reconciliation check
         ("is yesterday's offline trading on the books"), so it sits in the
         accounting hub beside the other checks that catch a figure going wrong.
         Lay-bys and Contracts stay: they are daily for the shops that use them,
         and LEAF_LABELS below only reaches a screen the menu names. */
    ],
  },
  /*
   * Inventory split in two.
   *
   * Its eight children were two unrelated jobs sharing a word: WHAT WE SELL
   * (products, departments, specials, instructions) and WHAT WE PHYSICALLY HAVE
   * and how it moves (purchasing, transfers, stock takes). Different people do
   * them, on different days. `CAPABILITY_GROUPS` in src/lib/site/permissions.ts
   * had already made exactly this split — products / purchasing / stock — and
   * the menu was the one taxonomy disagreeing with it.
   */
  {
    label: 'Products',
    icon: Table,
    items: [
      { label: 'Products', href: '/products', icon: Boxes, built: true, capability: 'products.view', description: 'Everything the shop sells, and what it costs' },
      { label: 'Departments', href: '/departments', icon: LayoutGrid, built: true, capability: 'products.view', description: 'How the product file is grouped and reported on' },
      { label: 'Specials', href: '/specials', icon: Tag, built: true, capability: 'products.edit', description: 'Promotional prices that start and end on a date' },
      /* Beside Specials rather than under Setup, and for the same reason Specials
         is here: both are prices that change themselves on a clock, and both are
         used by a shop owner weekly. Setup → Pricing is the SHAPE of pricing —
         which price types exist, what VAT applies — which is a different job. */
      { label: 'Price changes', href: '/pricing-schedules', icon: CalendarClock, built: true, capability: 'products.edit', description: 'New prices approved now to take effect later' },
      { label: 'Instructions', href: '/instructions', icon: Lightbulb, built: true, capability: 'products.view', description: 'The questions a till asks when an item is sold' },
      { label: 'Manufacturing', href: '/manufacturing', icon: Factory, built: true, capability: 'products.edit', module: 'inventory_advanced', description: 'Build stock from a recipe of other stock' },
    ],
  },
  {
    label: 'Stock',
    icon: PackageOpen,
    items: [
      /* Purchasing and Suppliers deliberately carry NO module. A shop that
         cannot order and receive stock cannot trade, so putting goods-received
         behind an add-on would make the Starter Pack unusable for any retailer.
         What Advanced Inventory sells is the control ON TOP of that: counting,
         correcting, moving and tracing. */
      { label: 'Purchasing', href: '/purchasing', icon: PackageOpen, built: true, capability: 'purchasing.view', description: 'Order stock and receive it against the order' },
      { label: 'Transfers', href: '/transfers', icon: ArrowLeftRight, built: true, capability: 'stock.transfer', module: 'inventory_advanced', description: 'Move stock between locations or stores' },
      { label: 'Stock Takes', href: '/stock-takes', icon: ClipboardList, built: true, capability: 'stock.adjust', module: 'inventory_advanced', description: 'Count what is on the shelf and correct the books' },
      /* Sits beside stock takes because it answers the same question from the
         other end: a count discovers a variance, an adjustment declares one. */
      { label: 'Adjustments', href: '/adjustments', icon: SlidersHorizontal, built: true, capability: 'stock.adjust', module: 'inventory_advanced', keywords: 'write off write-off shrinkage damage breakage wastage expired spoiled scrap', description: 'Write stock on or off with a reason, without counting the location' },
      { label: 'Batches', href: '/batches', icon: Boxes, built: true, capability: 'stock.view', module: 'inventory_advanced', keywords: 'lot expiry expiring fefo recall trace batch', description: 'Which lots are on the shelf, what is expiring, and where each went' },
      /* A supplier exists in this app because stock comes from one. Their age
         analysis and remittances are money questions and sit in that hub. */
      { label: 'Suppliers', href: '/suppliers', icon: Truck, built: true, capability: 'suppliers.view', description: 'Who the shop buys from, and what it owes them' },
    ],
  },
  {
    label: 'Customers',
    icon: Contact,
    items: [
      /* The section itself carries no module: gift cards are part of the base
         package, so the heading survives even when Customers and Loyalty are
         both switched off. */
      { label: 'Customers', href: '/customers', icon: Contact, built: true, capability: 'customers.view', module: 'customers', description: 'Accounts, contact details and history' },
      { label: 'Age analysis', href: '/customers/age-analysis', icon: BarChart, built: true, capability: 'customers.view', module: 'customers', description: 'Who owes what, and how overdue it is' },
      /* Directly after the age analysis: that screen says what is overdue,
         this one is where somebody does something about it. */
      { label: 'Collections', href: '/credit', icon: Bell, built: true, capability: 'customers.view', module: 'customers', description: 'Chase overdue accounts and record the outcome' },
      { label: 'Promises to pay', href: '/credit/promises', icon: Handshake, built: true, capability: 'customers.view', module: 'customers', description: 'What a customer undertook to pay, and by when' },
      { label: 'Statements', href: '/customers/statements', icon: Mail, built: true, capability: 'customers.view', module: 'customers', description: 'Send account statements out to customers' },
      /* The members list, which is the loyalty screen anybody actually opens.
         The programme, its tiers and the punch cards decide how it WORKS and
         are set once, so they are in the setup hub. */
      { label: 'Loyalty', href: '/loyalty', icon: Gem, built: true, capability: 'loyalty.view', module: 'loyalty', description: 'Members, their points and what they have earned' },
      /* Stored value, not a points programme — a shop that wants gift cards
         rarely wants loyalty, so this stays in the base package. */
      { label: 'Gift cards', href: '/gift-cards', icon: Gift, built: true, capability: 'giftcards.view', description: 'Sell, check and manage stored-value cards' },
    ],
  },
  /*
   * One link, not a group of thirteen — the same move Setup made, and for the
   * same reasons with more force. "Unallocated", "Interest", "Write-offs" and
   * "Periods" are exactly the screens nobody can choose between from the name
   * alone, and /accounting had no landing page at all, so the heading opened
   * onto nothing. The hub groups them by the question somebody arrives with.
   *
   * Gated on the weakest capability any tile requires, so anyone who can see a
   * single screen gets in and the hub drops the rest.
   */
  {
    label: 'Accounting',
    icon: Scale,
    href: '/accounting',
    built: true,
    capability: 'cashbook.view',
    /* Deliberately NO `module` here, even though there is an Accounting module.
       The hub also holds the cashbook, expenses and the VAT return, which are
       part of the base package — every shop banks money and pays bills. What
       the module sells is the double-entry layer on top, so the gating is on
       those TILES (see accounting/catalogue.ts) rather than on this section.
       Tagging the section would take a Starter Pack shop's bank account away. */
    keywords: 'money ledger books financials vat tax cashbook expenses debtors creditors',
    description: 'The books — ledgers, VAT, expenses and the bank',
  },
  /*
   * One link too. The hub already leads with built-in reports, whatever the
   * shop has built, and their favourites. Naming "Build a report", "Generate
   * with AI" and "Scheduled reports" here as well put three shortcuts to a hub
   * in the menu directly beside the hub — the two-front-doors problem in
   * miniature. The search still finds them by name via the keywords below.
   */
  {
    label: 'Reports',
    icon: PieChart,
    href: '/reports',
    built: true,
    capability: 'reports.view',
    keywords: 'build a report generate with ai scheduled reports email me analytics multi store group consolidated branches',
    description: 'Built-in reports, your own, and ones you schedule',
  },
  /*
   * Cross-store reporting is NOT a menu section of its own any more.
   *
   * It was "Group" — a permanent two-row section for the minority of shops with
   * linked stores, naming a word they do not use for themselves. Both screens
   * are reports covering more than one store, so they are reports: listed in the
   * reports catalogue under "Multi-store" and named in SUBPAGE_LABELS below.
   * The link between stores is still a GROUP in the control database; only what
   * a user reads and types changed.
   */
  {
    /* Staff and Commission answered the same question from opposite ends —
       what the business pays a person, and what that person brought in — so
       they are one section. Pay rules and Cost per employee moved to the setup
       hub: both are configuration that decides what the figures here come to. */
    label: 'Staff',
    icon: Users,
    items: [
      /* The clock leads: it is the screen somebody opens every morning, while
         People is opened when a person joins or their terms change. */
      { label: 'Clock in and out', href: '/staff/clock', icon: Clock, built: true, capability: 'staff.clock', description: 'Start and end a shift on the floor' },
      { label: 'Timesheets', href: '/staff/timesheets', icon: ClipboardList, built: true, capability: 'staff.view_own', description: 'Hours worked, and approving them for pay' },
      { label: 'Leave', href: '/staff/leave', icon: CalendarRange, built: true, capability: 'staff.view_own', description: 'Requests, balances and who is away when' },
      { label: 'People', href: '/staff', icon: Contact, built: true, capability: 'staff.view_all', description: 'Everyone who works here and their terms' },
      { label: 'Commission', href: '/commission', icon: Percent, built: true, capability: 'commission.view_own', description: 'What each person earned on what they sold' },
    ],
  },
  /*
   * One link, not a group of eleven.
   *
   * The hub at /online-store lists every screen grouped by the job it does,
   * with a line on each saying what it decides — which a menu could never do.
   * Eleven rows mixing three operational screens with eight settings, in a
   * section most shops never switch on, cost every one of them a permanent
   * group. `SUBPAGE_LABELS` below is now the only list of them.
   */
  {
    label: 'Online Store',
    icon: ShoppingBag,
    href: '/online-store',
    built: true,
    capability: 'online.view',
    module: 'online_store',
    keywords: 'web shop ecommerce storefront online orders discounts pages checkout',
    description: 'The public shop — orders, pages and what it sells',
  },
  /*
   * One link, not a group of fourteen.
   *
   * The hub at /setup lists every setting grouped by the job it does, with a
   * line on each saying what it decides — which a menu could never do. Naming
   * all fourteen here as well made the sidebar's longest section a flat list
   * that answered nothing, and gave every setting two front doors that could
   * disagree. `SUBPAGE_LABELS` below is now the only list of them.
   *
   * `setup.view` gates it: the weakest capability any tile requires, so anyone
   * with a single setting still gets in and the hub drops the rest.
   */
  { label: 'Setup', icon: Settings, href: '/setup', built: true, capability: 'setup.view', description: 'How this shop is configured, from tills to VAT' },
  /*
   * Job Cards, back with routes.
   *
   * It was removed for rendering "Not built yet" — a promise the menu could not
   * keep, costing a permanent row. This is the promise kept.
   *
   * Two rows, not a hub. hub.ts is explicit that a hub is what a section becomes
   * when its screens are "too many, too unfamiliar and too rarely opened to work
   * as a flat menu group" — which describes Setup and Online Store, and is the
   * opposite of this. For a service business these are the screens they live in
   * all day, and a hub would put a click between a technician and their work.
   * Sales and Stock stayed flat for the same reason.
   *
   * The workflow settings go under /setup via SETUP_ELSEWHERE rather than here,
   * so this section never becomes the flat list of settings that Setup and
   * Online Store were created to undo.
   */
  {
    label: 'Job cards',
    icon: Wrench,
    /* On the SECTION, not on each of its ten items: job cards are one purchase,
       so a shop that has not bought them should see no heading at all rather
       than an empty one. */
    module: 'job_cards',
    items: [
      {
        /* FIRST in the section, because it is the screen a technician opens and
           the job list is the one an office user opens. The section is read from
           the top by whoever is holding the phone. */
        label: 'My work',
        href: '/jobs/my-work',
        icon: Clock,
        built: true,
        capability: 'jobs.view',
        keywords: 'my work today mine assigned to me technician next visit outstanding checks timer running',
        description: 'What is on your plate right now',
      },
      {
        /* Before the job list, because a request is what comes BEFORE a job:
           somebody outside the business asking, waiting for an answer. Leaving
           it further down would make the queue the thing nobody opens, which is
           the one failure mode this screen exists to prevent. */
        label: 'Requests',
        href: '/jobs/requests',
        icon: Mail,
        built: true,
        capability: 'jobs.edit',
        keywords: 'request requests intake enquiry enquiries public form website callout lead new work incoming',
        description: 'Work asked for from outside, waiting to be accepted',
      },
      {
        label: 'Job list',
        href: '/jobs',
        icon: ListOrdered,
        built: true,
        capability: 'jobs.view',
        keywords: 'jobcard job card work order service repair technician callout maintenance install',
        description: 'Every job, searchable and filterable',
      },
      {
        label: 'Board',
        href: '/jobs/board',
        icon: LayoutGrid,
        built: true,
        capability: 'jobs.view',
        keywords: 'kanban board columns workshop stages drag pipeline',
        description: 'The day at a glance, by the stage each job is at',
      },
      {
        label: 'Schedule',
        href: '/jobs/schedule',
        icon: CalendarClock,
        built: true,
        capability: 'jobs.view',
        keywords: 'calendar diary schedule appointments visits technician dispatch day roster',
        description: 'Who is going where today, and what has no slot yet',
      },
      {
        label: 'Recurring work',
        href: '/jobs/recurring',
        icon: CalendarClock,
        built: true,
        capability: 'jobs.view',
        keywords: 'recurring repeat schedule series maintenance contract periodic quarterly annual service plan',
        description: 'Schedules that raise a job when it falls due',
      },
      {
        /* "Parts asked for", not "Requests" — /jobs/requests above is already
           inbound WORK from outside the business, and two menu entries a
           technician reads as the same word is how somebody ends up on the
           wrong queue. This one is internal: our people asking for stock. */
        label: 'Parts asked for',
        href: '/jobs/part-requests',
        icon: Package,
        built: true,
        capability: 'jobs.view',
        keywords: 'part parts request requests order stock shortage backorder buy purchase needed waiting unavailable',
        description: 'What technicians need that is not on the shelf',
      },
      {
        label: 'Equipment',
        href: '/jobs/equipment',
        icon: Wrench,
        built: true,
        capability: 'jobs.view',
        keywords: 'asset assets equipment machine unit serial warranty service history plant customer owned',
        description: 'What we look after for customers, and what is due a service',
      },
      {
        label: 'Service targets',
        href: '/jobs/sla',
        icon: Clock,
        built: true,
        capability: 'jobs.view',
        keywords: 'sla service level agreement response time resolution deadline breach overdue target promise',
        description: 'Who is waiting for a reply, and what is about to be late',
      },
      {
        /* LAST, and deliberately so: everything above is work in flight, which
           is what this section is opened for daily. Reading back over a period
           is a different, less frequent job — but it belongs here rather than
           only in Reports, because the person who wants it is already in this
           section and the general catalogue is mostly about tills and stock.
           The main Reports hub no longer lists these, so this is their one
           front door. */
        label: 'Reports',
        href: '/jobs/reports',
        icon: BarChart,
        built: true,
        capability: 'jobs.view',
        keywords: 'report reports analysis technician write off absorbed billable invoiced travel visits sla breaches overdue stage productivity',
        description: 'What the work earned, and where it is going wrong',
      },
    ],
  },
  /*
   * Tickets: its own top-level section, not a child of Job cards (165).
   *
   * A support desk and a field team are usually different people. Somebody
   * answering the phone all day wants this section open and never opens Job
   * cards; a technician is the reverse. Nesting it would put a daily screen two
   * clicks deep for the people who live in it.
   *
   * The two sections are next to each other because a ticket often becomes a
   * job, and that is the one path between them.
   */
  {
    label: 'Tickets',
    icon: Ticket,
    keywords: 'support helpdesk service desk enquiry issue incident request customer query',
    items: [
      {
        /* FIRST, because the board is what a support desk leaves open all day.
           The list is what they visit when looking for one thing. */
        label: 'Board',
        href: '/tickets/board',
        icon: LayoutGrid,
        built: true,
        capability: 'tickets.view',
        keywords: 'kanban lanes columns drag swimlane queue',
        description: 'What the desk is working on, and whose clock is running',
      },
      {
        label: 'All tickets',
        href: '/tickets',
        icon: ListOrdered,
        built: true,
        capability: 'tickets.view',
        keywords: 'list search history closed resolved find',
        description: 'Every ticket, open and closed, with what each one took',
      },
    ],
  },
]

/**
 * The menu as one user sees it.
 *
 * A section disappears once every child is hidden — a "Setup" heading that
 * opens onto nothing reads as a broken menu rather than a restricted one.
 * Sections with no children at all (the unbuilt ones) are left alone.
 */
export function navFor(
  granted: (capability: string) => boolean,
  /**
   * Whether the shop holds a module. Defaults to "yes to everything", so a
   * caller that predates module gating keeps its old behaviour rather than
   * silently losing half its menu.
   */
  holds: (module: string) => boolean = () => true,
): NavSection[] {
  const visible: NavSection[] = []
  const allowed = (entry: { capability?: string; module?: string }) =>
    (!entry.capability || granted(entry.capability)) && (!entry.module || holds(entry.module))

  for (const section of NAV) {
    if (section.href) {
      if (allowed(section)) visible.push(section)
      continue
    }
    if (!section.items?.length) {
      visible.push(section)
      continue
    }
    /* A section carrying its own module hides wholesale — Job cards is one
       purchase, not ten independent ones, so filtering it item by item would
       leave an empty heading behind. */
    if (section.module && !holds(section.module)) continue

    const items = section.items.filter(allowed)
    if (items.length) visible.push({ ...section, items })
  }

  return visible
}

export type Crumb = { label: string; href?: string }

/**
 * The name of every screen reached from a hub rather than from the menu.
 *
 * These screens are NOT in `NAV`: their section is a single link to a hub, and the hub is
 * where they are listed. So this is the only place they are named, and everything that
 * needs a name reads it from here — the hub's tiles, the breadcrumb below, and the sidebar
 * search. Renaming a screen is one edit and the three follow together.
 *
 * Written as a literal rather than derived from anything, because each hub leans on the
 * key type: a catalogue narrows `SubpageHref` to its own prefix, which makes a tile
 * pointing at a screen that does not exist a COMPILE ERROR rather than a page that renders
 * with no name. A `Record<string, string>` would widen the keys and silently accept a typo.
 */
export const SUBPAGE_LABELS = {
  '/setup/users': 'Users',
  '/setup/audit': 'Audit trail',
  '/setup/api': 'API & webhooks',
  '/setup/roles': 'Roles & permissions',
  '/setup/linked-stores': 'Linked stores',
  '/setup/locations': 'Stock locations',
  '/setup/adjustment-reasons': 'Adjustment reasons',
  '/setup/sales-reasons': 'Void & return reasons',
  '/setup/pricing': 'Price types & VAT',
  '/setup/customer-groups': 'Customer groups',
  '/setup/purchasing': 'Purchasing & cost',
  '/setup/tender-types': 'Tender types',
  '/setup/tips': 'Tips',
  // "Tills", not "Terminals" — it is what the screen's own heading says, and
  // what somebody in a shop calls the thing. The keyword search still has
  // "terminals" on the tile, so looking for either finds it.
  '/setup/terminals': 'Tills',
  '/setup/billing': 'Plan & billing',
  '/setup/numbering': 'Numbering',
  '/setup/quick-keys': 'Quick keys',
  '/setup/menu-designer': 'Menu designer',
  '/setup/tables': 'Tables',
  '/setup/reservations': 'Reservations',
  /* "Job workflow", not "Job statuses": the screen configures the stages AND the
     boards that show them, and somebody looking for either should find it. */
  '/setup/job-workflow': 'Job workflow',
  /* "Tickets", matching the section it configures. The lanes and the running
     limit are one screen because both answer "how does this desk work". */
  '/setup/tickets': 'Tickets',
  '/setup/custom-fields': 'Custom fields',
  '/setup/reconciliation': 'Reconciliation',
  '/setup/opening-balances': 'Opening balances',
  '/setup/import': 'Import data',
  '/setup/laybys': 'Lay-bys',
  '/setup/sms': 'Text messages',
  '/setup/printing': 'Printing',
  '/setup/expense-categories': 'Expense categories',
  '/setup/databases': 'Site & databases',
  '/setup/training': 'Training mode',
  '/setup/style-guide': 'Style guide',
  /* Configuration that lives under another section's route but belongs in the
     setup hub: each is set once and decides what the daily screens above it
     come to. The route is not moved — only where it is listed. */
  '/staff/pay-rules': 'Pay rules',
  '/staff/cost': 'Cost per employee',
  '/credit/levels': 'Credit levels',
  '/loyalty/programme': 'Loyalty programme',
  '/loyalty/tiers': 'Loyalty tiers',
  '/loyalty/cards': 'Punch cards',
  /* Commission rules had no entry here at all — no tile, no breadcrumb, no
     search — reachable only by somebody already standing on /commission who
     knew to look. It decides what every figure on that screen comes to, which
     is the same job as pay rules, so it is listed in the same place. */
  '/commission/rules': 'Commission rules',

  // ── Accounting ────────────────────────────────────────────────────────
  '/accounting/income-statement': 'Profit and loss',
  '/accounting/balance-sheet': 'Balance sheet',
  '/accounting/cash-flow': 'Cash flow',
  '/accounting/budgets': 'Budgets',
  '/accounting/trial-balance': 'Trial balance',
  '/accounting/vat': 'VAT return',
  '/accounting/journals': 'Journals',
  // Below Journals rather than beside them: the breadcrumb reads
  // "Accounting › Journals › Recurring", which is where they belong.
  '/accounting/journals/recurring': 'Recurring journals',
  '/accounting/accounts': 'Chart of accounts',
  '/accounting/assets': 'Fixed assets',
  // Below Fixed assets rather than beside it: the breadcrumb reads
  // "Accounting › Fixed assets › Depreciation", which is where it belongs.
  '/accounting/assets/depreciation': 'Depreciation',
  '/accounting/unallocated': 'Unallocated',
  '/accounting/interest': 'Interest',
  '/accounting/write-offs': 'Write-offs',
  '/accounting/periods': 'Periods',
  '/cashbook': 'Cashbook',
  '/cashbook/import': 'Import a statement',
  '/expenses': 'Expenses',
  '/expenses/recurring': 'Recurring expenses',
  '/suppliers/age-analysis': 'Supplier age analysis',
  '/suppliers/remittances': 'Remittances',
  '/credit/runs': 'Collection runs',
  '/sales/offline': 'Offline sales',

  // ── Online store ──────────────────────────────────────────────────────
  '/online-store/orders': 'Orders',
  '/online-store/products': 'Products',
  '/online-store/departments': 'Departments',
  '/online-store/reviews': 'Reviews',
  '/online-store/statuses': 'Order statuses',
  '/online-store/trading': 'Trading hours',
  '/online-store/discounts': 'Discount codes',
  '/online-store/funnel': 'Shopper funnel',
  '/online-store/builder': 'Page builder',
  '/online-store/pages': 'Pages',
  '/online-store/payments': 'Payments',
  '/online-store/setup': 'Store setup',

  // ── Reports ───────────────────────────────────────────────────────────
  /* The reports hub renders its own catalogue and does not read this map, so
     this is here for the setup hub's cross-reference and the breadcrumb — a
     schedule is configuration ("email me the sales summary every Monday")
     that somebody looks for under settings as readily as under reports. */
  '/reports/schedules': 'Scheduled reports',
  '/reports/stock-intel': 'Stock intelligence',
  /* Cross-store, for a shop with linked stores. Named here rather than in the
     menu because they are reports, and the catalogue is where a report is
     found — see the note where the Group section used to be. */
  '/reports/multi-store': 'Multi-store overview',
  /* A sibling route, not a child: the two are peers, and `breadcrumbFor` turns
     any named screen that is a proper prefix into a middle crumb — so
     /reports/multi-store/income-statement would read as though the P&L lived
     inside the overview. */
  '/reports/multi-store-income-statement': 'Multi-store profit and loss',
  '/reports/multi-store-sales': 'Sales by store',
  '/reports/multi-store-like-for-like': 'Like-for-like sales',
  '/reports/multi-store-stock': 'Stock across stores',
  '/reports/multi-store-transfers': 'Store transfers',
  '/reports/multi-store-mix': 'Sales mix by store',
  '/reports/multi-store-balance-sheet': 'Multi-store balance sheet',
} as const

/**
 * Any screen a hub lists. Each catalogue narrows this to its own prefix, so a
 * tile can only point at a screen this map has named.
 */
export type SubpageHref = keyof typeof SUBPAGE_LABELS

/**
 * Which hub owns a screen whose ROUTE does not sit beneath it.
 *
 * Most hub screens live under their hub's path, and the prefix says so:
 * /setup/tills belongs to /setup. But a hub groups by the QUESTION SOMEBODY
 * ARRIVES WITH, not by URL, so the accounting hub lists /cashbook, /expenses
 * and the supplier age analysis — screens whose routes are top-level or belong
 * to another section entirely. Without this map their breadcrumb falls back to
 * a URL prefix that does not exist, and the screen renders with no trail and no
 * way back to the hub that sent them there.
 *
 * Only exceptions need an entry; a screen under its own hub is inferred.
 */
const SUBPAGE_OWNER: Partial<Record<SubpageHref, string>> = {
  '/cashbook': '/accounting',
  '/cashbook/import': '/accounting',
  '/expenses': '/accounting',
  '/expenses/recurring': '/accounting',
  '/suppliers/age-analysis': '/accounting',
  '/suppliers/remittances': '/accounting',
  '/credit/runs': '/accounting',
  '/sales/offline': '/accounting',
  '/staff/pay-rules': '/setup',
  '/staff/cost': '/setup',
  '/credit/levels': '/setup',
  '/loyalty/programme': '/setup',
  '/loyalty/tiers': '/setup',
  '/loyalty/cards': '/setup',
  /* Beside pay rules, for the same reason: it is set once and decides what
     every figure on /commission comes to. It had no owner at all before, so
     its breadcrumb fell through to a prefix that is not a hub and the screen
     rendered with no trail and no way back. */
  '/commission/rules': '/setup',
}

/**
 * Settings the setup hub SHOWS but does not OWN.
 *
 * The hub is meant to be the one place somebody looks for a setting, and about
 * a dozen live under another section: the online store's own switches, the
 * accounting period lock, scheduled reports. Moving them is wrong — each is
 * genuinely part of its module and its own hub lists it — and so is claiming
 * them in `SUBPAGE_OWNER`, which would rewrite the breadcrumb and strand the
 * screen away from the hub it belongs to. "Store setup" reached from the online
 * store must still read "Online Store › Store setup".
 *
 * So the setup hub lists them as CROSS-REFERENCES: a tile that goes to the real
 * screen, in the real module, whose trail stays that module's. Being listed in
 * two hubs is the point — this is the second front door, and unlike the
 * sidebar's it cannot disagree with the first, because both read one label.
 *
 * Membership is here rather than in the catalogue so `hubFor` stays the single
 * answer to "who owns this" and the catalogue cannot quietly claim a screen by
 * listing it.
 */
export const SETUP_ELSEWHERE = [
  '/online-store/setup',
  '/online-store/statuses',
  '/online-store/trading',
  '/online-store/payments',
  '/online-store/discounts',
  '/accounting/accounts',
  '/accounting/periods',
  '/expenses/recurring',
  '/reports/schedules',
] as const satisfies readonly SubpageHref[]

/** The hub a screen belongs to, by route prefix unless declared otherwise. */
export function hubFor(pathname: string): string | null {
  const declared = SUBPAGE_OWNER[pathname as SubpageHref]
  if (declared) return declared
  if (!(pathname in SUBPAGE_LABELS)) return null
  const section = NAV.find((s) => s.href && pathname.startsWith(`${s.href}/`))
  return section?.href ?? null
}

/**
 * Search synonyms for hub screens, keyed the same way.
 *
 * Nav owns this because `filterNav` lives here and a hub's screens are no
 * longer menu entries — without synonyms, someone typing "terminals" or "till"
 * finds nothing, because the screen is called "Tills" and is not in the menu at
 * all. The DESCRIPTIONS stay on the catalogues: only a hub renders one, and two
 * authored strings per screen is exactly the drift this file warns about above.
 */
export const SUBPAGE_KEYWORDS: Partial<Record<SubpageHref, string>> = {
  '/setup/users': 'staff logins pin passwords accounts sales rep',
  '/setup/audit': 'audit log history who changed sign in login security trail',
  '/setup/api': 'api keys integration webhooks rest developer tokens external',
  '/setup/roles': 'security capabilities rights access control permissions',
  '/setup/linked-stores': 'multi store group branches sharing',
  '/setup/locations': 'warehouse storeroom bins branches',
  '/setup/adjustment-reasons': 'write off shrinkage damage breakage wastage codes',
  '/setup/sales-reasons': 'void cancel reasons refund return credit note faulty codes exception',
  '/setup/pricing': 'tax rates price structures markup reprice vat',
  '/setup/customer-groups':
    'customer groups categories wholesale retail staff trade terms price structure defaults segment',
  '/setup/tender-types': 'cash card eft payment methods vouchers',
  '/setup/tips': 'tips gratuity service charge tiers waiter pool',
  '/setup/terminals': 'terminals registers pos devices',
  '/setup/billing': 'plan subscription modules upgrade downgrade invoice licence price cost add-on account debit order',
  '/setup/numbering': 'sequences document numbers prefix autocode',
  '/setup/quick-keys': 'buttons tiles favourites shortcuts till pos grid',
  /* No "arrange": every substring of a keyword matches, and it would make this
     screen a hit for "rang" — which is how somebody finds Tills. */
  '/setup/menu-designer':
    'menu designer browse grid departments categories order sort drag tiles till pos catalogue',
  '/setup/tables': 'restaurant hospitality floor sections covers waiter bills',
  '/setup/reservations': 'bookings diary online booking form opening hours sittings covers restaurant',
  '/setup/reconciliation': 'drift integrity check invariants audit',
  '/setup/opening-balances': 'import migration debtors creditors go live',
  '/setup/import': 'csv xlsx excel spreadsheet upload bulk load migrate products customers suppliers departments stock take',
  '/setup/laybys': 'deposit cancellation fee terms instalments',
  '/setup/sms': 'sms text message smsportal reminders dunning notify phone mobile',
  '/setup/printing': 'receipt printer thermal esc pos slip 80mm cash drawer kick kitchen bridge',
  '/setup/expense-categories': 'chart of accounts spending overheads account codes',
  '/setup/databases': 'connection health server site details',
  '/setup/training': 'training practice demo test sandbox learn staff dummy trial reset clear',
  '/setup/style-guide': 'design system components reference ui kit',
  /* Configuration under another section's route. Without these, somebody who
     types "commission" or "overtime" into the sidebar gets nothing back for
     the screens that actually decide those figures. */
  '/staff/pay-rules': 'overtime rates wages salary hourly bcea holidays sunday',
  '/staff/cost': 'wages salary labour cost payroll per employee',
  '/commission/rules': 'commission rates rules percentage sales rep earnings targets',
  '/credit/levels': 'credit limit terms account hold blocked risk dunning reminders',
  '/loyalty/programme': 'points rewards earn rate redemption programme rules',
  '/loyalty/tiers': 'tiers levels vip bronze silver gold status benefits',
  '/loyalty/cards': 'punch card stamps buy x get y free coffee',
  /* Settings the setup hub cross-references — see SETUP_ELSEWHERE. */
  '/online-store/setup': 'domain url delivery fees shipping open closed launch go live web shop',
  '/online-store/statuses': 'workflow stages pipeline packing shipped fulfilment',
  '/online-store/trading': 'hours open closed holidays busy pause sold out collection times',
  '/online-store/payments': 'payfast yoco ozow gateway card eft checkout',
  '/online-store/discounts': 'promo coupon voucher promotion sale code',
  '/accounting/accounts': 'chart of accounts ledger codes general ledger',
  '/accounting/periods': 'period lock close month year end freeze',
  '/expenses/recurring': 'standing order repeating monthly rent subscription',
  '/reports/schedules': 'scheduled email me automatic recurring report delivery',
  /* "group" stays a synonym: it is what the section used to be called and what
     the setting under Setup still groups stores into, so somebody who learnt
     the old word must still land on these. */
  '/reports/multi-store': 'multi store group consolidated branches linked stores combined all stores side by side',
  '/reports/multi-store-income-statement':
    'multi store group consolidated p&l income statement profit all stores branches',
  '/reports/multi-store-sales':
    'multi store group sales by store turnover daily monthly trend branches compare growth',
  /* "same store" and "comp" are what this measure is called elsewhere — a
     retailer who learnt the term in one chain must find it here. */
  '/reports/multi-store-like-for-like':
    'like for like lfl same store sales comp growth year on year multi store group branches',
  '/reports/multi-store-stock':
    'stock on hand across stores rebalance transfer surplus shortage overstock understock multi store group branches',
  /* No "reconciliation" here, deliberately: that word belongs to Setup →
     Reconciliation, and every substring of a keyword matches — "reconcil" would
     then return two sections and stop pointing anywhere in particular. This
     screen is found by what it holds, not by the check it performs. */
  '/reports/multi-store-transfers':
    'store transfers in transit counted twice unsettled stale goods on the road between branches multi store group',
  /* No "tender" or "reconcil": every substring of a keyword matches, and both
     words belong to Setup screens that configure them. test-navigation.ts uses
     /reports + "tender" as its canonical example of a term that must not leak
     across subtrees. "paid" and "payment mix" reach this screen instead. */
  '/reports/multi-store-mix':
    'department hour trading pattern mix how paid payment cash card busiest peak multi store group branches',
  '/reports/multi-store-balance-sheet':
    'consolidated balance sheet assets liabilities equity net worth multi store group branches',
}

/**
 * Does a screen below `href` — one the menu does not itself list — match?
 *
 * Only Setup has such screens today. Exported because the sidebar needs the same answer
 * twice: once to keep the row while searching, and once to decide whether to hand the
 * term on to the hub.
 */
export function subpageMatches(href: string, needle: string): boolean {
  const q = needle.trim().toLowerCase()
  if (!q) return false
  return Object.entries(SUBPAGE_LABELS).some(([path, label]) => {
    /* Ownership, not URL prefix — the setup hub lists /staff/pay-rules and the
       accounting hub lists /cashbook, and a prefix test would find neither. */
    if (hubFor(path) !== href) return false
    if (label.toLowerCase().includes(q)) return true
    /* Synonyms too: the screen is called "Tills", and somebody looking for it
       is as likely to type "terminal" or "register". */
    return SUBPAGE_KEYWORDS[path as SubpageHref]?.includes(q) ?? false
  })
}

/** Trailing crumb for a detail route, by section base path. */
const LEAF_LABELS: Record<string, { new: string; edit: string }> = {
  '/products': { new: 'New product', edit: 'Edit product' },
  '/departments': { new: 'New department', edit: 'Edit department' },
  '/instructions': { new: 'New instruction', edit: 'Edit instruction' },
  '/customers': { new: 'New customer', edit: 'Customer' },
  '/suppliers': { new: 'New supplier', edit: 'Supplier' },
  /* A job card is worked on for days and edited throughout, but the crumb names
     the thing: the same screen serves an open job and a closed one, and "Edit
     job" over a job that was finished last month reads wrongly. */
  '/jobs': { new: 'New job', edit: 'Job card' },
  /* /jobs/board/[slug] is not a detail route at all — the segment names WHICH
     board, and the board's own name is already the page heading. Without an
     entry the fallback labelled every board "Edit". */
  '/jobs/board': { new: 'Board', edit: 'Board' },
  /* Not "Edit equipment": the same screen serves a unit in daily use and one
     scrapped two years ago, and "Edit" over a retired asset reads wrongly. */
  '/jobs/equipment': { new: 'Add equipment', edit: 'Equipment' },
  /* "Ticket", not "Edit": the screen is a conversation and a record of what was
     done, and most of what happens on it — commenting, moving a lane, starting
     the clock — is not editing anything. The fallback labelled it "Edit". */
  '/tickets': { new: 'New ticket', edit: 'Ticket' },
  /* /sales itself redirects to the register now, but /sales/[id] is still where
     an issued document lives. It is never "edited" — the screen is a record of
     what went out — so the crumb names the thing rather than the action. */
  '/sales': { new: 'Point of sale', edit: 'Document' },
  /* Unlike /sales/[id], an invoice here IS being edited until it is finalised. */
  '/invoicing': { new: 'New invoice', edit: 'Invoice' },
  '/invoicing/orders': { new: 'New order', edit: 'Order' },
  /* A posted transfer is a record of what moved, not something anyone edits. */
  '/transfers': { new: 'New transfer', edit: 'Transfer' },
  /* A draft adjustment IS edited, but the same screen serves a posted one, so
     the crumb names the thing rather than the action. */
  '/adjustments': { new: 'New adjustment', edit: 'Adjustment' },
  /* A sheet IS edited while it is being counted, but the crumb names the thing
     rather than the action because the same screen serves a posted one. */
  '/stock-takes': { new: 'New stock take', edit: 'Stock take' },
  /* Likewise a posted build: the screen records what was consumed and made. */
  '/manufacturing': { new: 'New build', edit: 'Build' },
  '/invoicing/laybys': { new: 'New lay-by', edit: 'Lay-by' },
  /* A contract's detail screen is a record of what it bills and what it has
     billed, not an edit form — editing is a separate route under it. */
  '/sales/contracts': { new: 'New contract', edit: 'Contract' },
}

/**
 * The breadcrumb for a path, derived rather than passed down — the shell
 * renders above the page and has no way to be told.
 */
export function breadcrumbFor(pathname: string): { icon: LucideIcon; crumbs: Crumb[] } | null {
  /* A screen a hub lists, which the menu therefore does not name. Resolved
     BEFORE the section scan below, because a hub screen's route can sit under
     another section entirely — /sales/offline is listed by the accounting hub,
     and a prefix scan would file it under Sales and never reach the hub that
     actually sent somebody there. */
  const owner = hubFor(pathname)
  if (owner) {
    const section = NAV.find((s) => s.href === owner)
    if (section) {
      const named = SUBPAGE_LABELS as Record<string, string>

      /* A hub screen can itself have a screen below it — /accounting/assets and
         /accounting/assets/depreciation are both listed. The middle crumb is
         whichever named screen is a proper prefix of this one, so the trail
         reads "Accounting › Fixed assets › Depreciation" rather than skipping
         the page the depreciation run belongs to. */
      const parent = Object.keys(named)
        .filter((p) => pathname.startsWith(`${p}/`) && hubFor(p) === owner)
        .sort((a, b) => b.length - a.length)[0]

      return {
        icon: section.icon,
        crumbs: [
          { label: section.label, href: section.href },
          ...(parent ? [{ label: named[parent], href: parent }] : []),
          { label: named[pathname] },
        ],
      }
    }
  }

  for (const section of NAV) {
    // A section that is itself a link, e.g. Dashboard.
    if (section.href && pathname === section.href) {
      return { icon: section.icon, crumbs: [{ label: section.label }] }
    }

    /* Longest href wins, not first declared. A section can hold both /customers
       and /customers/age-analysis, and matching in declaration order would file
       the age analysis under "Customers › Customers". */
    const match = (section.items ?? [])
      .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]

    if (match) {
      const item = match
      const crumbs: Crumb[] = [{ label: section.label }]

      /* Skip a child crumb that just repeats its section — the Customers
         section's own list is "Customers", and "Customers › Customers" reads
         like a mistake. Deeper crumbs still hang off the section. */
      if (item.label !== section.label) {
        crumbs.push({ label: item.label, href: pathname === item.href ? undefined : item.href })
      }

      // Anything deeper is a detail route: /products/new or /products/12.
      const rest = pathname.slice(item.href.length).replace(/^\//, '')
      if (rest) {
        const labels = LEAF_LABELS[item.href]
        const leaf = rest === 'new' ? (labels?.new ?? 'New') : (labels?.edit ?? 'Edit')
        /* A leaf that just repeats its parent adds nothing — /jobs/board/workshop
           is still the Board screen, and the board's own name is the heading. The
           same reasoning as the section-repeat skip above. */
        if (leaf !== item.label) crumbs.push({ label: leaf })
      }

      return { icon: section.icon, crumbs }
    }
  }
  return null
}

/** Sections and items whose label matches `term`, for the sidebar search. */
export function filterNav(term: string, sections: NavSection[] = NAV): NavSection[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return sections

  const hit = (label: string, keywords?: string) =>
    label.toLowerCase().includes(needle) || (keywords?.includes(needle) ?? false)

  return sections.flatMap((section) => {
    if (hit(section.label, section.keywords)) return [section]

    /* A linked section keeps its place if one of the screens BELOW it matches.
       Setup is the case: the menu no longer names "Tender types", so without
       this the box that promises to search settings would find none of them.
       The href stays clean — the sidebar appends the term itself when it
       renders the row, so the hub opens already filtered without the highlight
       having to reason about query strings. */
    if (section.href && !section.items?.length && subpageMatches(section.href, needle)) {
      return [section]
    }

    const items = (section.items ?? []).filter((i) => hit(i.label, i.keywords))
    return items.length ? [{ ...section, items }] : []
  })
}

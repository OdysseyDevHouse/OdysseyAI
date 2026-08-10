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
  Lightbulb,
  Factory,
  Contact,
  Package,
  PieChart,
  Settings,
  Store,
  Palette,
  Wrench,
  ShoppingBag,
  Gem,
  Stamp,
  Plus,
  Receipt,
  FileText,
  Users,
  KeyRound,
  Undo2 as Reverse,
  ListOrdered,
  ChartColumn as BarChart,
  Mail,
  Truck,
  CreditCard,
  Monitor,
  Hash,
  Coins,
  CloudOff,
  Check,
  Warehouse,
  Database,
  MessageSquare,
  Landmark,
  Scale,
  Percent,
  Lock,
  Bell,
  Clock,
  CalendarRange,
  Handshake,
  Sparkles,
  Repeat,
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
}

export type NavSection = {
  label: string
  icon: LucideIcon
  /** A section with no children is a link in its own right. */
  href?: string
  items?: NavItem[]
  built?: boolean
  capability?: string
}

export const NAV: NavSection[] = [
  { label: 'Dashboard', icon: Home, href: '/dashboard', built: true, capability: 'dashboard.view' },
  {
    label: 'Sales',
    icon: LineChart,
    items: [
      { label: 'New sale', href: '/pos', icon: Plus, built: true, capability: 'sales.till' },
      { label: 'Invoicing', href: '/sales/invoicing', icon: FileText, built: true, capability: 'sales.edit' },
      { label: 'Documents', href: '/sales', icon: Receipt, built: true, capability: 'sales.view' },
      { label: 'Orders', href: '/sales/orders', icon: ListOrdered, built: true, capability: 'sales.view' },
      { label: 'Quotes', href: '/sales/quotes', icon: FileText, built: true, capability: 'sales.view' },
      { label: 'Lay-bys', href: '/sales/laybys', icon: Package, built: true, capability: 'sales.view' },
      { label: 'Contracts', href: '/sales/contracts', icon: Repeat, built: true, capability: 'contracts.view' },
      { label: 'Returns', href: '/sales/returns', icon: Reverse, built: true, capability: 'sales.credit_note' },
      { label: 'Cash-up', href: '/sales/cashup', icon: Coins, built: true, capability: 'sales.cashup' },
      /* Sales rung up with no connection. Under Sales rather than Setup because
         it is a daily trading question — "is yesterday's offline trading on the
         books" — not a configuration one. */
      { label: 'Offline sales', href: '/sales/offline', icon: CloudOff, built: true, capability: 'sales.view' },
    ],
  },
  {
    label: 'Inventory',
    icon: Table,
    items: [
      { label: 'Products', href: '/products', icon: Boxes, built: true, capability: 'products.view' },
      { label: 'Departments', href: '/departments', icon: LayoutGrid, built: true, capability: 'products.view' },
      { label: 'Stock Takes', href: '/stock-takes', icon: ClipboardList, capability: 'stock.adjust' },
      { label: 'Purchasing', href: '/purchasing', icon: PackageOpen, built: true, capability: 'purchasing.view' },
      { label: 'Transfers', href: '/transfers', icon: ArrowLeftRight, built: true, capability: 'stock.transfer' },
      { label: 'Specials', href: '/specials', icon: Tag, built: true, capability: 'products.edit' },
      { label: 'Instructions', href: '/instructions', icon: Lightbulb, built: true, capability: 'products.view' },
      { label: 'Manufacturing', href: '/manufacturing', icon: Factory, capability: 'products.edit' },
    ],
  },
  {
    label: 'Customers',
    icon: Contact,
    items: [
      { label: 'Customers', href: '/customers', icon: Contact, built: true, capability: 'customers.view' },
      { label: 'Age analysis', href: '/customers/age-analysis', icon: BarChart, built: true, capability: 'customers.view' },
      /* Directly after the age analysis: that screen says what is overdue,
         this one is where somebody does something about it. */
      { label: 'Collections', href: '/credit', icon: Bell, built: true, capability: 'customers.view' },
      { label: 'Promises to pay', href: '/credit/promises', icon: Handshake, built: true, capability: 'customers.view' },
      { label: 'Statements', href: '/customers/statements', icon: Mail, built: true, capability: 'customers.view' },
    ],
  },
  {
    label: 'Suppliers',
    icon: Package,
    items: [
      { label: 'Suppliers', href: '/suppliers', icon: Truck, built: true, capability: 'suppliers.view' },
      { label: 'Age analysis', href: '/suppliers/age-analysis', icon: BarChart, built: true, capability: 'suppliers.view' },
      { label: 'Remittances', href: '/suppliers/remittances', icon: Mail, built: true, capability: 'purchasing.pay' },
    ],
  },
  {
    // Where the money itself lives, as opposed to what the ledgers say about
    // it. Sits after both sub-ledgers because it reconciles against them.
    label: 'Accounting',
    icon: Scale,
    items: [
      // The three statements lead: they are what anyone opens this menu for,
      // and everything below them is the machinery that produces them.
      { label: 'Profit and loss', href: '/accounting/income-statement', icon: LineChart, built: true, capability: 'reports.financial' },
      { label: 'Balance sheet', href: '/accounting/balance-sheet', icon: Scale, built: true, capability: 'reports.financial' },
      { label: 'Trial balance', href: '/accounting/trial-balance', icon: BarChart, built: true, capability: 'reports.financial' },
      { label: 'Cashbook', href: '/cashbook', icon: Landmark, built: true, capability: 'cashbook.view' },
      // Everything the business spends that is not stock. Sits directly under
      // the cashbook because most expenses come straight out of one.
      { label: 'Expenses', href: '/expenses', icon: Receipt, built: true, capability: 'cashbook.view' },
      { label: 'VAT return', href: '/accounting/vat', icon: Percent, built: true, capability: 'reports.financial' },
      { label: 'Journals', href: '/accounting/journals', icon: FileText, built: true, capability: 'reports.financial' },
      { label: 'Chart of accounts', href: '/accounting/accounts', icon: ListOrdered, built: true, capability: 'reports.financial' },
      // What the business owns and uses, and the depreciation that turns it
      // into a cost over the years it is used.
      { label: 'Fixed assets', href: '/accounting/assets', icon: Warehouse, built: true, capability: 'reports.financial' },
      { label: 'Unallocated', href: '/accounting/unallocated', icon: Coins, built: true, capability: 'cashbook.view' },
      { label: 'Interest', href: '/accounting/interest', icon: Percent, built: true, capability: 'customers.credit' },
      { label: 'Write-offs', href: '/accounting/write-offs', icon: Reverse, built: true, capability: 'customers.credit' },
      { label: 'Periods', href: '/accounting/periods', icon: Lock, built: true, capability: 'setup.edit' },
    ],
  },
  {
    label: 'Reports',
    icon: PieChart,
    items: [
      /* The hub leads because it is the one entry point people should learn:
         built-in reports, whatever the shop has built, and their favourites are
         all on it. The two below are shortcuts to the same place, kept in the
         menu because "build a report" and "email me this" are things people go
         looking for by name. */
      { label: 'All reports', href: '/reports', icon: PieChart, built: true, capability: 'reports.view' },
      { label: 'Build a report', href: '/reports/builder', icon: Table, built: true, capability: 'reports.build' },
      { label: 'Generate with AI', href: '/reports/ask', icon: Sparkles, built: true, capability: 'reports.ai' },
      { label: 'Scheduled reports', href: '/reports/schedules', icon: Clock, built: true, capability: 'reports.schedule' },
    ],
  },
  {
    // Sits beside Commission because the two answer the same question from
    // opposite ends: what the business pays a person, and what that person
    // brought in.
    label: 'Staff',
    icon: Users,
    items: [
      /* The clock leads: it is the screen somebody opens every morning, while
         People is opened when a person joins or their terms change. */
      { label: 'Clock in and out', href: '/staff/clock', icon: Clock, built: true, capability: 'staff.clock' },
      { label: 'Timesheets', href: '/staff/timesheets', icon: ClipboardList, built: true, capability: 'staff.view_own' },
      { label: 'Leave', href: '/staff/leave', icon: CalendarRange, built: true, capability: 'staff.view_own' },
      { label: 'People', href: '/staff', icon: Contact, built: true, capability: 'staff.view_all' },
      { label: 'Cost per employee', href: '/staff/cost', icon: Coins, built: true, capability: 'staff.cost' },
      /* Last, and on staff.cost: this is configuration rather than a daily
         screen, and it decides what every figure above it comes to. */
      { label: 'Pay rules', href: '/staff/pay-rules', icon: Settings, built: true, capability: 'staff.cost' },
    ],
  },
  {
    label: 'Commission',
    icon: Percent,
    items: [
      { label: 'Periods', href: '/commission', icon: Coins, built: true, capability: 'commission.view_own' },
      { label: 'Rules', href: '/commission/rules', icon: Settings, built: true, capability: 'commission.edit' },
    ],
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
  { label: 'Setup', icon: Settings, href: '/setup', built: true, capability: 'setup.view' },
  { label: 'Job Cards', icon: Wrench, items: [] },
  {
    label: 'Online Store',
    icon: ShoppingBag,
    items: [
      { label: 'Orders', href: '/online-store/orders', icon: Receipt, built: true, capability: 'online.view' },
      { label: 'Products', href: '/online-store/products', icon: Package, built: true, capability: 'online.edit' },
      { label: 'Departments', href: '/online-store/departments', icon: LayoutGrid, built: true, capability: 'online.edit' },
      { label: 'Reviews', href: '/online-store/reviews', icon: MessageSquare, built: true, capability: 'online.view' },
      { label: 'Order statuses', href: '/online-store/statuses', icon: ListOrdered, built: true, capability: 'online.edit' },
      { label: 'Discount codes', href: '/online-store/discounts', icon: Tag, built: true, capability: 'online.edit' },
      { label: 'Shopper funnel', href: '/online-store/funnel', icon: BarChart, built: true, capability: 'online.view' },
      { label: 'Page builder', href: '/online-store/builder', icon: Palette, built: true, capability: 'online.edit' },
      { label: 'Pages', href: '/online-store/pages', icon: FileText, built: true, capability: 'online.edit' },
      { label: 'Payments', href: '/online-store/payments', icon: CreditCard, built: true, capability: 'online.edit' },
      { label: 'Setup', href: '/online-store/setup', icon: Settings, built: true, capability: 'online.edit' },
    ],
  },
  {
    label: 'Loyalty',
    icon: Gem,
    items: [
      { label: 'Members', href: '/loyalty', icon: Contact, built: true, capability: 'loyalty.view' },
      { label: 'Programme', href: '/loyalty/programme', icon: Settings, built: true, capability: 'loyalty.view' },
      { label: 'Tiers', href: '/loyalty/tiers', icon: Gem, built: true, capability: 'loyalty.view' },
      { label: 'Punch cards', href: '/loyalty/cards', icon: Stamp, built: true, capability: 'loyalty.view' },
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
export function navFor(granted: (capability: string) => boolean): NavSection[] {
  const visible: NavSection[] = []

  for (const section of NAV) {
    if (section.href) {
      if (!section.capability || granted(section.capability)) visible.push(section)
      continue
    }
    if (!section.items?.length) {
      visible.push(section)
      continue
    }
    const items = section.items.filter((item) => !item.capability || granted(item.capability))
    if (items.length) visible.push({ ...section, items })
  }

  return visible
}

export type Crumb = { label: string; href?: string }

/**
 * The name of each setup screen, keyed by its route.
 *
 * These screens are NOT in `NAV`: Setup is a single link to a hub, and the hub is where
 * they are listed. So this is the only place they are named, and everything that needs a
 * name reads it from here — the hub's tiles, the breadcrumb below, and the sidebar
 * search. Renaming a screen is one edit and the three follow together.
 *
 * Written as a literal rather than derived from anything, because the hub leans on the
 * key type: `SetupHref = keyof typeof SUBPAGE_LABELS` makes a tile pointing at a screen
 * that does not exist a COMPILE ERROR rather than a page that renders with no name. A
 * `Record<string, string>` would widen the keys and silently accept a typo.
 */
export const SUBPAGE_LABELS = {
  '/setup/users': 'Users',
  '/setup/roles': 'Roles & permissions',
  '/setup/linked-stores': 'Linked stores',
  '/setup/locations': 'Stock locations',
  '/setup/pricing': 'Price types & VAT',
  '/setup/tender-types': 'Tender types',
  // "Tills", not "Terminals" — it is what the screen's own heading says, and
  // what somebody in a shop calls the thing. The keyword search still has
  // "terminals" on the tile, so looking for either finds it.
  '/setup/terminals': 'Tills',
  '/setup/numbering': 'Numbering',
  '/setup/quick-keys': 'Quick keys',
  '/setup/tables': 'Tables',
  '/setup/reconciliation': 'Reconciliation',
  '/setup/opening-balances': 'Opening balances',
  '/setup/laybys': 'Lay-bys',
  '/setup/expense-categories': 'Expense categories',
  '/setup/databases': 'Site & databases',
  '/setup/style-guide': 'Style guide',
} as const

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
  return Object.entries(SUBPAGE_LABELS).some(
    ([path, label]) => path.startsWith(`${href}/`) && label.toLowerCase().includes(q),
  )
}

/** Trailing crumb for a detail route, by section base path. */
const LEAF_LABELS: Record<string, { new: string; edit: string }> = {
  '/products': { new: 'New product', edit: 'Edit product' },
  '/departments': { new: 'New department', edit: 'Edit department' },
  '/instructions': { new: 'New instruction', edit: 'Edit instruction' },
  '/customers': { new: 'New customer', edit: 'Customer' },
  '/suppliers': { new: 'New supplier', edit: 'Supplier' },
  /* A finalised document is never "edited" — the detail screen is a record of
     what was issued, so the crumb names the thing rather than the action. */
  '/sales': { new: 'New sale', edit: 'Document' },
  /* Unlike /sales, an invoice here IS being edited until it is finalised. */
  '/sales/invoicing': { new: 'New invoice', edit: 'Invoice' },
  '/sales/orders': { new: 'New order', edit: 'Order' },
  /* A posted transfer is a record of what moved, not something anyone edits. */
  '/transfers': { new: 'New transfer', edit: 'Transfer' },
  '/sales/laybys': { new: 'New lay-by', edit: 'Lay-by' },
  /* A contract's detail screen is a record of what it bills and what it has
     billed, not an edit form — editing is a separate route under it. */
  '/sales/contracts': { new: 'New contract', edit: 'Contract' },
}

/**
 * The breadcrumb for a path, derived rather than passed down — the shell
 * renders above the page and has no way to be told.
 */
export function breadcrumbFor(pathname: string): { icon: LucideIcon; crumbs: Crumb[] } | null {
  for (const section of NAV) {
    // A section that is itself a link, e.g. Dashboard.
    if (section.href && pathname === section.href) {
      return { icon: section.icon, crumbs: [{ label: section.label }] }
    }

    /* A linked section can still have screens BELOW it that the menu does not
       list — Setup is the case: one entry, fourteen screens, all reached from
       the hub. Without this they render with no trail at all and no way back
       to the hub but the browser's own button. The leaf is named from
       SUBPAGE_LABELS, which the hub's tiles read too, so the crumb and the
       tile can never disagree. */
    if (section.href && pathname.startsWith(`${section.href}/`)) {
      const label = (SUBPAGE_LABELS as Record<string, string>)[pathname]
      return {
        icon: section.icon,
        crumbs: [{ label: section.label, href: section.href }, ...(label ? [{ label }] : [])],
      }
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
        crumbs.push({
          label: rest === 'new' ? (labels?.new ?? 'New') : (labels?.edit ?? 'Edit'),
        })
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

  return sections.flatMap((section) => {
    if (section.label.toLowerCase().includes(needle)) return [section]

    /* A linked section keeps its place if one of the screens BELOW it matches.
       Setup is the case: the menu no longer names "Tender types", so without
       this the box that promises to search settings would find none of them.
       The href stays clean — the sidebar appends the term itself when it
       renders the row, so the hub opens already filtered without the highlight
       having to reason about query strings. */
    if (section.href && !section.items?.length && subpageMatches(section.href, needle)) {
      return [section]
    }

    const items = (section.items ?? []).filter((i) => i.label.toLowerCase().includes(needle))
    return items.length ? [{ ...section, items }] : []
  })
}

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
  Check,
  Warehouse,
  Database,
  MessageSquare,
  Landmark,
  Scale,
  Percent,
  Lock,
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
      { label: 'New sale', href: '/sales/new', icon: Plus, built: true, capability: 'sales.till' },
      { label: 'Invoicing', href: '/sales/invoicing', icon: FileText, built: true, capability: 'sales.edit' },
      { label: 'Documents', href: '/sales', icon: Receipt, built: true, capability: 'sales.view' },
      { label: 'Orders', href: '/sales/orders', icon: ListOrdered, built: true, capability: 'sales.view' },
      { label: 'Quotes', href: '/sales/quotes', icon: FileText, capability: 'sales.view' },
      { label: 'Lay-bys', href: '/sales/laybys', icon: Package, built: true, capability: 'sales.view' },
      { label: 'Returns', href: '/sales/returns', icon: Reverse, built: true, capability: 'sales.credit_note' },
      { label: 'Cash-up', href: '/sales/cashup', icon: Coins, built: true, capability: 'sales.cashup' },
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
      { label: 'Specials', href: '/specials', icon: Tag, capability: 'products.edit' },
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
      { label: 'Cashbook', href: '/cashbook', icon: Landmark, built: true, capability: 'cashbook.view' },
      // Everything the business spends that is not stock. Sits directly under
      // the cashbook because most expenses come straight out of one.
      { label: 'Expenses', href: '/expenses', icon: Receipt, built: true, capability: 'cashbook.view' },
      { label: 'VAT return', href: '/accounting/vat', icon: Percent, built: true, capability: 'reports.financial' },
      { label: 'Unallocated', href: '/accounting/unallocated', icon: Coins, built: true, capability: 'cashbook.view' },
      { label: 'Interest', href: '/accounting/interest', icon: Percent, built: true, capability: 'customers.credit' },
      { label: 'Write-offs', href: '/accounting/write-offs', icon: Reverse, built: true, capability: 'customers.credit' },
      { label: 'Periods', href: '/accounting/periods', icon: Lock, built: true, capability: 'setup.edit' },
    ],
  },
  { label: 'Reports', icon: PieChart, href: '/reports', built: true, capability: 'reports.view' },
  {
    label: 'Commission',
    icon: Percent,
    items: [
      { label: 'Periods', href: '/commission', icon: Coins, built: true, capability: 'commission.view_own' },
      { label: 'Rules', href: '/commission/rules', icon: Settings, built: true, capability: 'commission.edit' },
    ],
  },
  {
    label: 'Setup',
    icon: Settings,
    items: [
      { label: 'Users', href: '/setup/users', icon: Users, built: true, capability: 'setup.users' },
      { label: 'Roles & permissions', href: '/setup/roles', icon: KeyRound, built: true, capability: 'setup.users' },
      { label: 'Linked stores', href: '/setup/linked-stores', icon: Store, built: true, capability: 'setup.edit' },
      { label: 'Stock locations', href: '/setup/locations', icon: Warehouse, built: true, capability: 'setup.edit' },
      { label: 'Tender types', href: '/setup/tender-types', icon: CreditCard, built: true, capability: 'setup.edit' },
      { label: 'Terminals', href: '/setup/terminals', icon: Monitor, built: true, capability: 'setup.edit' },
      { label: 'Numbering', href: '/setup/numbering', icon: Hash, built: true, capability: 'setup.edit' },
      { label: 'Reconciliation', href: '/setup/reconciliation', icon: Check, built: true, capability: 'setup.edit' },
      { label: 'Opening balances', href: '/setup/opening-balances', icon: FileText, built: true, capability: 'setup.edit' },
      { label: 'Lay-bys', href: '/setup/laybys', icon: Package, built: true, capability: 'setup.edit' },
      // The seed of the chart of accounts — see the note on the screen itself.
      { label: 'Expense categories', href: '/setup/expense-categories', icon: Scale, built: true, capability: 'setup.edit' },
      { label: 'Site & databases', href: '/setup/databases', icon: Database, built: true, capability: 'setup.edit' },
      { label: 'Style Guide', href: '/setup/style-guide', icon: Palette, built: true, capability: 'setup.view' },
    ],
  },
  { label: 'Job Cards', icon: Wrench, items: [] },
  {
    label: 'Online Store',
    icon: ShoppingBag,
    items: [
      { label: 'Orders', href: '/online-store/orders', icon: Receipt, built: true, capability: 'online.view' },
      { label: 'Departments', href: '/online-store/departments', icon: LayoutGrid, built: true, capability: 'online.edit' },
      { label: 'Reviews', href: '/online-store/reviews', icon: MessageSquare, built: true, capability: 'online.view' },
      { label: 'Page builder', href: '/online-store/builder', icon: Palette, built: true, capability: 'online.edit' },
      { label: 'Payments', href: '/online-store/payments', icon: CreditCard, built: true, capability: 'online.edit' },
      { label: 'Setup', href: '/online-store/setup', icon: Settings, built: true, capability: 'online.edit' },
    ],
  },
  { label: 'Loyalty', icon: Gem, items: [] },
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

    const items = (section.items ?? []).filter((i) => i.label.toLowerCase().includes(needle))
    return items.length ? [{ ...section, items }] : []
  })
}

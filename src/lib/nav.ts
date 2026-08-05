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
}

export type NavSection = {
  label: string
  icon: LucideIcon
  /** A section with no children is a link in its own right. */
  href?: string
  items?: NavItem[]
  built?: boolean
}

export const NAV: NavSection[] = [
  { label: 'Dashboard', icon: Home, href: '/dashboard', built: true },
  {
    label: 'Sales',
    icon: LineChart,
    items: [
      { label: 'New sale', href: '/sales/new', icon: Plus, built: true },
      { label: 'Documents', href: '/sales', icon: Receipt, built: true },
      { label: 'Orders', href: '/sales/orders', icon: ListOrdered, built: true },
      { label: 'Quotes', href: '/sales/quotes', icon: FileText },
      { label: 'Lay-bys', href: '/sales/laybys', icon: Package, built: true },
      { label: 'Returns', href: '/sales/returns', icon: Reverse, built: true },
      { label: 'Cash-up', href: '/sales/cashup', icon: Coins, built: true },
    ],
  },
  {
    label: 'Inventory',
    icon: Table,
    items: [
      { label: 'Products', href: '/products', icon: Boxes, built: true },
      { label: 'Departments', href: '/departments', icon: LayoutGrid, built: true },
      { label: 'Stock Takes', href: '/stock-takes', icon: ClipboardList },
      { label: 'Purchasing', href: '/purchasing', icon: PackageOpen, built: true },
      { label: 'Transfers', href: '/transfers', icon: ArrowLeftRight, built: true },
      { label: 'Specials', href: '/specials', icon: Tag },
      { label: 'Instructions', href: '/instructions', icon: Lightbulb, built: true },
      { label: 'Manufacturing', href: '/manufacturing', icon: Factory },
    ],
  },
  {
    label: 'Customers',
    icon: Contact,
    items: [
      { label: 'Customers', href: '/customers', icon: Contact, built: true },
      { label: 'Age analysis', href: '/customers/age-analysis', icon: BarChart, built: true },
      { label: 'Statements', href: '/customers/statements', icon: Mail, built: true },
    ],
  },
  {
    label: 'Suppliers',
    icon: Package,
    items: [
      { label: 'Suppliers', href: '/suppliers', icon: Truck, built: true },
      { label: 'Age analysis', href: '/suppliers/age-analysis', icon: BarChart, built: true },
      { label: 'Remittances', href: '/suppliers/remittances', icon: Mail, built: true },
    ],
  },
  { label: 'Reports', icon: PieChart, href: '/reports', built: true },
  {
    label: 'Setup',
    icon: Settings,
    items: [
      { label: 'Linked stores', href: '/setup/linked-stores', icon: Store, built: true },
      { label: 'Stock locations', href: '/setup/locations', icon: Warehouse, built: true },
      { label: 'Tender types', href: '/setup/tender-types', icon: CreditCard, built: true },
      { label: 'Terminals', href: '/setup/terminals', icon: Monitor, built: true },
      { label: 'Numbering', href: '/setup/numbering', icon: Hash, built: true },
      { label: 'Reconciliation', href: '/setup/reconciliation', icon: Check, built: true },
      { label: 'Opening balances', href: '/setup/opening-balances', icon: FileText, built: true },
      { label: 'Lay-bys', href: '/setup/laybys', icon: Package, built: true },
      { label: 'Permissions', href: '/setup/permissions', icon: KeyRound, built: true },
      { label: 'Style Guide', href: '/setup/style-guide', icon: Palette, built: true },
    ],
  },
  { label: 'Job Cards', icon: Wrench, items: [] },
  { label: 'Online Store', icon: ShoppingBag, items: [] },
  { label: 'Loyalty', icon: Gem, items: [] },
]

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
export function filterNav(term: string): NavSection[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return NAV

  return NAV.flatMap((section) => {
    if (section.label.toLowerCase().includes(needle)) return [section]

    const items = (section.items ?? []).filter((i) => i.label.toLowerCase().includes(needle))
    return items.length ? [{ ...section, items }] : []
  })
}

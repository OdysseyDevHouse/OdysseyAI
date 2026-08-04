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
  { label: 'Sales', icon: LineChart, items: [] },
  {
    label: 'Inventory',
    icon: Table,
    items: [
      { label: 'Products', href: '/products', icon: Boxes, built: true },
      { label: 'Departments', href: '/departments', icon: LayoutGrid, built: true },
      { label: 'Stock Takes', href: '/stock-takes', icon: ClipboardList },
      { label: 'Orders / GRV', href: '/orders', icon: PackageOpen },
      { label: 'Transfers', href: '/transfers', icon: ArrowLeftRight },
      { label: 'Specials', href: '/specials', icon: Tag },
      { label: 'Instructions', href: '/instructions', icon: Lightbulb },
      { label: 'Manufacturing', href: '/manufacturing', icon: Factory },
    ],
  },
  { label: 'Customers', icon: Contact, items: [] },
  { label: 'Suppliers', icon: Package, items: [] },
  { label: 'Reports', icon: PieChart, items: [] },
  {
    label: 'Setup',
    icon: Settings,
    items: [
      { label: 'Linked stores', href: '/setup/linked-stores', icon: Store, built: true },
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

    for (const item of section.items ?? []) {
      if (pathname !== item.href && !pathname.startsWith(`${item.href}/`)) continue

      const crumbs: Crumb[] = [
        { label: section.label },
        { label: item.label, href: pathname === item.href ? undefined : item.href },
      ]

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

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Drawer, Icons, TabBar, type TabBarItem } from '@/components/ui'
import { LayoutPreferenceSwitch } from '@/components/LayoutPreferenceSwitch'
import { navFor, GETTING_STARTED_HREF, type NavSection } from '@/lib/nav'

/**
 * The phone's main navigation: four destinations along the bottom, and the
 * whole menu behind the fifth.
 *
 * ── WHY THIS REPLACED THE HAMBURGER ─────────────────────────────────────────
 *
 * Every screen used to be two taps behind a button in the top-left corner —
 * the furthest point on a handset from the thumb holding it — and the bar said
 * nothing about where you were. Four tabs put the screens somebody actually
 * opens on the floor one tap away and make the current one visible, which is
 * the half a drawer can never do. The drawer itself is not gone: it is "More",
 * with every section in it exactly as before.
 *
 * ── WHICH FOUR, AND WHY THEY ARE NOT CONFIGURABLE ───────────────────────────
 *
 * The dashboard, reports, the product file and purchase orders. That is the
 * set a manager away from their desk actually opens: how is trading, look
 * something up, what did we order. Everything else is a job done sitting down.
 *
 * They are fixed rather than a preference because a tab bar whose contents move
 * is a tab bar nobody learns — the whole value is that the third tab is always
 * the same thing. What DOES vary is how many appear: a tab is dropped when the
 * user could not open the screen anyway.
 *
 * ── THE FILTER IS THE DRAWER'S OWN ──────────────────────────────────────────
 *
 * A tab is offered only if `navFor` produced its href for this user, rather
 * than by re-testing capabilities here. Two rules would eventually disagree,
 * and the way that fails is a tab leading to a not-allowed page. One rule, read
 * twice: the same principle MobileTopBar's menu is built on.
 */

/** A tab, and the screen it is only offered with. */
const TABS: { key: string; label: string; href: string; icon: keyof typeof TAB_ICONS }[] = [
  { key: 'home', label: 'Home', href: '/dashboard', icon: 'home' },
  { key: 'reports', label: 'Reports', href: '/reports', icon: 'reports' },
  /* "Stock" rather than "Products": on the floor this tab answers "have we got
     any, and what does it cost", which is the product file. */
  { key: 'stock', label: 'Stock', href: '/products', icon: 'stock' },
  { key: 'orders', label: 'Orders', href: '/purchasing', icon: 'orders' },
]

/* Written out rather than pulled off the NAV entries, because a tab glyph has
   to read at 20px against four others — NAV's icons are chosen to be
   distinguishable in a list of forty, which is a different problem. */
const TAB_ICONS = {
  home: <Icons.LayoutGrid size={20} />,
  reports: <Icons.LineChart size={20} />,
  stock: <Icons.Boxes size={20} />,
  orders: <Icons.PackageOpen size={20} />,
}

export function PhoneNav({
  granted,
  isOwner,
  modules,
  hiddenAreas = [],
  gettingStartedHidden = false,
  userName,
  siteName,
  onChooseLayout,
}: {
  granted: string[]
  isOwner: boolean
  modules: string[]
  /** As on Sidebar — switched off under Setup → Menu & modules, not unbought. */
  hiddenAreas?: string[]
  /** As on Sidebar — the Getting started checklist, dismissed from its own page. */
  gettingStartedHidden?: boolean
  userName: string
  siteName: string
  /**
   * Switch to the full desktop layout. Passed rather than imported, so this bar
   * stays renderable without a request — see LayoutPreferenceSwitch.
   *
   * Omitted INSIDE THE APP, deliberately: a WebView has no address bar and no
   * browser back button, so a person who taps "Desktop site" there gets a
   * sidebar built for 1600px on a 390px screen and no obvious way back.
   */
  onChooseLayout?: (pref: 'phone' | 'desktop') => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  /* The same filter the sidebar runs, so the phone can never offer a screen the
     desktop hides — or hide one it offers. An owner passes every capability
     check; that is the rule NAV is written against. */
  const all: NavSection[] = navFor(
    (capability) => isOwner || granted.includes(capability),
    (module) => modules.includes(module),
    (area) => hiddenAreas.includes(area),
  )
  const sections = gettingStartedHidden
    ? all.filter((s) => s.href !== GETTING_STARTED_HREF)
    : all

  /* Every destination this user may open, flattened. A tab checks its href
     against this rather than re-deriving who may see what. */
  const reachable = new Set<string>()
  for (const section of sections) {
    if (section.href) reachable.add(section.href)
    for (const item of section.items ?? []) {
      if (item.href && item.built !== false) reachable.add(item.href)
    }
  }

  const items: TabBarItem[] = TABS.filter((tab) => reachable.has(tab.href)).map((tab) => ({
    key: tab.key,
    label: tab.label,
    icon: TAB_ICONS[tab.icon],
    href: tab.href,
    /* Prefix rather than equality: /products/bulk-pricing is still Stock, and a
       tab bar that goes blank one level deep reads as having lost its place. */
    active: pathname === tab.href || pathname.startsWith(`${tab.href}/`),
  }))

  items.push({
    key: 'more',
    label: 'More',
    icon: <Icons.MoreHorizontal size={20} />,
    onClick: () => setOpen(true),
    active: open,
  })

  return (
    <>
      <TabBar items={items} />

      <Drawer open={open} onClose={() => setOpen(false)} title="Menu" side="left" size="md">
        <div className="flex flex-col gap-1 p-2">
          {sections.map((section) => (
            <MenuSection
              key={section.label}
              section={section}
              pathname={pathname}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </div>
        <div className="border-t border-border px-4 py-3">
          <div className="text-sm font-medium text-ink">{userName}</div>
          <div className="text-xs text-muted">{siteName}</div>
        </div>
        {/* Last in the drawer, not on the bar. It is the thing you go looking
            for once, not a control you use while working. */}
        {onChooseLayout && (
          <div className="border-t border-border px-2 py-2">
            <LayoutPreferenceSwitch current="phone" onChoose={onChooseLayout} />
          </div>
        )}
      </Drawer>
    </>
  )
}

/**
 * One section of the menu.
 *
 * Sections render FLAT — heading, then its items — rather than as accordions.
 * A collapsed section is a second tap before the user has seen anything, and on
 * a screen this size the whole menu is one scroll anyway.
 */
function MenuSection({
  section,
  pathname,
  onNavigate,
}: {
  section: NavSection
  pathname: string
  onNavigate: () => void
}) {
  const items = section.items ?? []

  if (section.href) {
    return (
      <MenuLink href={section.href} label={section.label} pathname={pathname} onNavigate={onNavigate} />
    )
  }
  if (!items.length) return null

  return (
    <div className="pt-2">
      <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
        {section.label}
      </div>
      {items.map((item) =>
        /* `built: false` marks a destination NAV knows about but nothing serves
           yet. Offering it would be a dead end dressed as a screen. */
        item.built === false || !item.href ? null : (
          <MenuLink
            key={item.href}
            href={item.href}
            label={item.label}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ),
      )}
    </div>
  )
}

function MenuLink({
  href,
  label,
  pathname,
  onNavigate,
}: {
  href: string
  label: string
  pathname: string
  onNavigate: () => void
}) {
  const active = pathname === href || pathname.startsWith(`${href}/`)
  return (
    <Link
      href={href}
      onClick={onNavigate}
      /* A nav row, not a button: it must read as a destination and match its
         siblings. 44px tall for the same touch-target reason as the tab bar. */
      data-kit-ok
      className={`flex min-h-11 items-center justify-between gap-2 rounded-control px-3 py-2.5 text-sm ${
        active ? 'bg-brand-soft font-medium text-brand-ink' : 'text-ink-2 active:bg-surface-2'
      }`}
    >
      <span className="truncate">{label}</span>
      <Icons.ChevronRight size={16} className="shrink-0 text-faint" />
    </Link>
  )
}

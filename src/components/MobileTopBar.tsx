'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Button, ButtonLink, Drawer, Icons } from '@/components/ui'
import { breadcrumbFor, navFor, type NavSection } from '@/lib/nav'

/**
 * The phone's title bar and menu.
 *
 * ── WHY THE WEB DRAWS THIS AT ALL ───────────────────────────────────────────
 *
 * The native shell owns the OUTER chrome — the status bar, the back gesture,
 * biometric unlock. What it cannot own is a menu whose contents depend on this
 * user's capabilities and this shop's modules: that answer lives on the server
 * and changes when a role changes. A native menu would either duplicate
 * `navFor` in Kotlin and Swift — three copies of one rule, two of which drift —
 * or fetch it and render it, which is what this already is.
 *
 * So the split is: native owns the frame, the web owns what is INSIDE it.
 *
 * ── ONE BAR, NOT A COPY OF TopBar ───────────────────────────────────────────
 *
 * TopBar carries a store switcher, a global search box, a notification bell and
 * a user menu — four affordances across a 1600px span. None of them survive a
 * 390px screen intact, and shrinking each until it fits is how a phone screen
 * ends up with four 24px targets nobody can hit. This shows the screen's name
 * and one menu button, and lets the drawer carry the rest.
 */
export function MobileTopBar({
  granted,
  isOwner,
  modules,
  hiddenAreas = [],
  userName,
  siteName,
  unreadNotifications,
}: {
  granted: string[]
  isOwner: boolean
  modules: string[]
  /** As on Sidebar — switched off under Setup → Menu & modules, not unbought. */
  hiddenAreas?: string[]
  userName: string
  siteName: string
  unreadNotifications: number
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  /* The same filter the sidebar runs, so the phone can never offer a screen the
     desktop hides — or hide one it offers. An owner passes every capability
     check; that is the rule NAV is written against. */
  const sections: NavSection[] = navFor(
    (capability) => isOwner || granted.includes(capability),
    (module) => modules.includes(module),
    (area) => hiddenAreas.includes(area),
  )

  /* The SCREEN's name, from the same breadcrumb source the desktop uses — not
     the store's, which sits underneath it. Passing the store name for both
     printed it twice, which is a fifth of a 390px bar spent saying one thing
     two ways.

     The last crumb is the screen; falling back to the store name matters for
     the route breadcrumbFor does not know, where a blank bar would read as a
     broken header rather than an unnamed page. */
  const crumbs = breadcrumbFor(pathname)?.crumbs ?? []
  const title = crumbs.length ? crumbs[crumbs.length - 1].label : siteName

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <Button
          variant="bare"
          size="touch"
          iconOnly
          onClick={() => setOpen(true)}
          aria-label="Open the menu"
        >
          <Icons.Menu size={22} />
        </Button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{title}</div>
          <div className="truncate text-xs text-muted">{siteName}</div>
        </div>

        <ButtonLink
          href="/notifications"
          variant="bare"
          size="touch"
          iconOnly
          aria-label={
            unreadNotifications > 0
              ? `Notifications (${unreadNotifications} unread)`
              : 'Notifications'
          }
          className="relative"
        >
          <Icons.Bell size={20} />
          {unreadNotifications > 0 && (
            <span className="absolute right-2 top-2 size-2 rounded-pill bg-danger" />
          )}
        </ButtonLink>
      </header>

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
    return <MenuLink href={section.href} label={section.label} pathname={pathname} onNavigate={onNavigate} />
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
         siblings. 44px tall for the same touch-target reason as the menu button. */
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

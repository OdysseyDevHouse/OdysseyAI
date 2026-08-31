'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, HelpCircle as CircleHelp, Settings, Bell, LogOut, ShieldCheck } from '@/components/ui/icons'
import { Button, ButtonLink, MenuItem } from '@/components/ui'
import { breadcrumbFor } from '@/lib/nav'
import StoreSwitcher, { type SwitcherSite } from './StoreSwitcher'
import ThemeToggle from './ThemeToggle'
import NotificationBell from './NotificationBell'

/** Initials for the avatar: "Tiaan Smith" -> "TI". */
function initials(name: string, email: string): string {
  const source = name.trim() || email.trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

function IconButton({
  label,
  icon: Icon,
  onClick,
  href,
  internal = false,
}: {
  label: string
  icon: typeof Bell
  onClick?: () => void
  /** Renders a link instead of a button — for a destination rather than an action. */
  href?: string
  /**
   * A route inside the app rather than a static file, so it soft-navigates in
   * this tab. The help guide is the other kind and stays the default: it lives
   * under public/, needs a real page load, and opens in its own tab so a
   * half-finished capture on this screen survives somebody reading it.
   */
  internal?: boolean
}) {
  if (href) {
    return (
      <ButtonLink
        href={href}
        target={internal ? undefined : '_blank'}
        rel={internal ? undefined : 'noopener'}
        prefetch={internal ? undefined : false}
        variant="bare"
        iconOnly
        title={label}
        aria-label={label}
      >
        <Icon size={18} />
      </ButtonLink>
    )
  }

  return (
    <Button variant="bare" iconOnly title={label} aria-label={label} onClick={onClick}>
      <Icon size={18} />
    </Button>
  )
}

export default function TopBar({
  sites,
  currentSiteId,
  userName,
  userEmail,
  roleName,
  unreadNotifications = 0,
}: {
  sites: SwitcherSite[]
  currentSiteId: number
  userName: string
  userEmail: string
  /** Null when nobody has given this person a role yet. */
  roleName?: string | null
  /** Server-computed at render; the bell keeps itself fresh from there. */
  unreadNotifications?: number
}) {
  const pathname = usePathname()
  const trail = breadcrumbFor(pathname)

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5">
        {trail && (
          <>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <trail.icon size={16} />
            </span>
            <ol className="flex min-w-0 items-center gap-1.5 text-sm">
              {trail.crumbs.map((crumb, i) => {
                const last = i === trail.crumbs.length - 1
                return (
                  <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <ChevronRight size={14} className="shrink-0 text-muted" />}
                    {crumb.href && !last ? (
                      <Link href={crumb.href} className="truncate text-muted hover:text-ink">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span
                        aria-current={last ? 'page' : undefined}
                        className={`truncate ${last ? 'font-semibold text-ink' : 'text-muted'}`}
                      >
                        {crumb.label}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        <StoreSwitcher sites={sites} currentId={currentSiteId} />

        {/* The help centre moved here from a card at the foot of the sidebar,
            which cost 90px of permanent chrome in a menu being quietened. */}
        <IconButton label="Help" icon={CircleHelp} href="/help.html" />
        {/* Straight to a hub, not a menu of shortcuts. The sidebar already
            has a Setup row, so a dropdown here would be a THIRD front door to
            the same screens — the problem src/lib/nav.ts records solving when
            the menu stopped naming all fourteen.

            The gear now opens /settings, the new system-settings screen, while
            the sidebar's Setup row still reaches /setup. Both are live on
            purpose: the two shapes are being compared before either goes. */}
        <IconButton label="Settings" icon={Settings} href="/settings" internal />
        <NotificationBell initialCount={unreadNotifications} />

        <div ref={menuRef} className="relative">
          {/* Deliberately not <Button>: an avatar is a circular identity badge
              showing initials, not a labelled action. Button's padding and
              min-height would stop it being a circle. */}
          <button
            data-kit-ok
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={userEmail}
            className="flex size-9 items-center justify-center rounded-pill bg-brand text-sm font-semibold text-white transition hover:bg-brand-ink"
          >
            {initials(userName, userEmail)}
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-1.5 w-56 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
            >
              <div className="border-b border-border px-3 py-2.5">
                <div className="truncate text-sm font-medium text-ink">{userName}</div>
                <div className="truncate text-xs text-muted">{userEmail}</div>
                {/* Worth showing now that roles are named by the shop: "Cashier"
                    explains a missing menu item in a way a blank space cannot. */}
                <div className="mt-1 truncate text-xs text-muted">
                  {roleName ?? 'No role assigned'}
                </div>
              </div>

              <div className="border-b border-border">
                <ThemeToggle />
              </div>

              <div className="border-b border-border p-1">
                <Link href="/security" onClick={() => setMenuOpen(false)}>
                  <MenuItem>
                    <ShieldCheck size={15} />
                    Two-factor authentication
                  </MenuItem>
                </Link>
              </div>

              <form action="/api/auth/signout" method="post" className="p-1">
                <MenuItem type="submit" tone="danger">
                  <LogOut size={15} />
                  Sign out
                </MenuItem>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

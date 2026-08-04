'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleHelp, Settings, Bell, LogOut } from 'lucide-react'
import { breadcrumbFor } from '@/lib/nav'
import StoreSwitcher, { type SwitcherSite } from './StoreSwitcher'
import ThemeToggle from './ThemeToggle'

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
}: {
  label: string
  icon: typeof Bell
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded-lg p-2 text-muted transition hover:bg-surface-2 hover:text-ink"
    >
      <Icon size={18} />
    </button>
  )
}

export default function TopBar({
  sites,
  currentSiteId,
  userName,
  userEmail,
}: {
  sites: SwitcherSite[]
  currentSiteId: number
  userName: string
  userEmail: string
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

        {/* Not wired up yet — present so the shell is complete. */}
        <IconButton label="Help" icon={CircleHelp} />
        <IconButton label="Settings" icon={Settings} />
        <IconButton label="Notifications" icon={Bell} />

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={userEmail}
            className="flex size-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white transition hover:bg-brand-ink"
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
              </div>

              <div className="border-b border-border">
                <ThemeToggle />
              </div>

              <form action="/api/auth/signout" method="post">
                <button
                  type="submit"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-muted transition hover:bg-surface-2 hover:text-danger"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

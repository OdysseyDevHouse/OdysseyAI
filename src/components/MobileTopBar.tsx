'use client'

import { usePathname } from 'next/navigation'
import { ButtonLink, Icons } from '@/components/ui'
import { breadcrumbFor } from '@/lib/nav'

/**
 * The phone's title bar.
 *
 * ── WHAT IT IS NOW, AND WHAT IT USED TO BE ──────────────────────────────────
 *
 * It used to carry the menu too: a hamburger on the left opening a drawer of
 * every section. That moved to the bottom of the screen — see PhoneNav — and
 * what is left here is the pair of things a title bar is actually for: which
 * screen you are on, and the one notification that might pull you off it.
 *
 * Dropping the button was the point rather than a side effect. The top-left
 * corner is the furthest reach on a handset held one-handed, and a bar with a
 * menu button, a title and a bell spends three of its 390 pixels-wide budget on
 * chrome while saying where you are exactly once.
 *
 * ── ONE BAR, NOT A COPY OF TopBar ───────────────────────────────────────────
 *
 * TopBar carries a store switcher, a global search box, a notification bell and
 * a user menu — four affordances across a 1600px span. None of them survive a
 * 390px screen intact, and shrinking each until it fits is how a phone screen
 * ends up with four 24px targets nobody can hit. This shows the screen's name
 * and the bell; the tab bar and its menu carry the rest.
 */
export function MobileTopBar({
  siteName,
  unreadNotifications,
}: {
  siteName: string
  unreadNotifications: number
}) {
  const pathname = usePathname()

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
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold text-ink">{title}</div>
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
  )
}

'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeft, Search, ChevronDown } from '@/components/ui/icons'
import { Button } from '@/components/ui'
import GlobalSearch from '@/components/GlobalSearch'
import {
  NAV,
  hubFor,
  navFor,
  type NavItem,
  type NavSection,
} from '@/lib/nav'
import {
  TILL_HREF,
  tillLinkProps,
  invoicingLinkProps,
  opensInInvoicingWindow,
} from '@/lib/openTill'

const STORAGE_KEY = 'odyssey.sidebar'

/** The older key, which held only the collapsed flag as '1' or '0'. */
const LEGACY_COLLAPSED_KEY = 'odyssey.sidebar.collapsed'

type Stored = { collapsed: boolean; open: string | null }

/**
 * The remembered sidebar state, tolerating the shape that came before it.
 *
 * Anyone who has used the app already has the legacy string key set, and
 * ignoring it would silently expand every sidebar that was deliberately
 * collapsed. Reading both means an existing preference survives the upgrade;
 * the next toggle writes the new shape and the old key stops mattering.
 */
function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>
      return {
        collapsed: parsed.collapsed === true,
        open: typeof parsed.open === 'string' ? parsed.open : null,
      }
    }
    const legacy = window.localStorage.getItem(LEGACY_COLLAPSED_KEY)
    if (legacy !== null) return { collapsed: legacy === '1', open: null }
  } catch {
    // Private mode, blocked storage, or a hand-edited value — defaults are fine.
  }
  return null
}

/**
 * The section containing this path, so it opens on load.
 *
 * Longest href wins rather than first declared, for the same reason the
 * highlight uses it: /sales sits in Sales and /setup/laybys in Setup, so a
 * first-match scan would open the wrong group for the deeper route.
 */
function sectionForPath(pathname: string, sections: NavSection[] = NAV): string | null {
  /* A hub's screen belongs to the hub, not to whatever section its URL sits
     under — otherwise opening /staff/pay-rules, which the setup hub lists,
     expands Staff and leaves Setup looking unvisited. */
  const owner = hubFor(pathname)
  if (owner) return sections.find((s) => s.href === owner)?.label ?? null

  let best: { label: string; length: number } | null = null

  for (const section of sections) {
    /* Only a GROUP can be the open section. Dashboard, Setup and every hub are
       links in their own right, and treating one as "open" both highlighted a
       row that has nothing to disclose and stopped the remembered group from
       being restored on the very routes that have no group of their own. */
    if (!section.items?.length) continue
    for (const item of section.items) {
      const href = item.href
      if (pathname !== href && !pathname.startsWith(`${href}/`)) continue
      if (!best || href.length > best.length) best = { label: section.label, length: href.length }
    }
  }

  return best?.label ?? null
}

/**
 * `granted` arrives as a plain array of capability strings rather than the
 * resolved NavSection[], because every section carries an icon COMPONENT and a
 * function cannot be serialised across the server/client boundary. The menu is
 * therefore rebuilt here from the same NAV the server used.
 */
export default function Sidebar({
  granted,
  isOwner,
  modules,
}: {
  granted: string[]
  isOwner: boolean
  /**
   * The modules this SHOP has bought, as plain strings for the same reason
   * `granted` is. Unlike capabilities, an owner does NOT bypass these: owning
   * the shop does not mean having paid for Loyalty.
   */
  modules: string[]
}) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  /* The global search palette. The sidebar owns it because the sidebar has
     already resolved which sections this user may see, and the palette searches
     exactly those — see `visible` below. */
  const [searchOpen, setSearchOpen] = useState(false)

  /* Declared before the open-section state below, which matches paths against
     it: a section this user cannot see must never be the one that opens.

     Keyed on the JOINED capabilities rather than the array: `granted` arrives
     from a server component and is a new array on every render, so depending on
     it directly rebuilt `visible` each time and re-fired every effect that
     watches it. */
  const grantedKey = granted.join(',')
  const modulesKey = modules.join(',')
  const visible = useMemo(() => {
    const held = new Set(granted)
    const bought = new Set(modules)
    /* The owner bypass applies to CAPABILITIES only. A capability is something
       an owner could grant themselves anyway, so short-circuiting it saves a
       round trip and changes nothing. A module is something they would have to
       BUY, and showing an owner a menu of features their shop does not have
       would be a link to a page that turns them away. */
    return navFor(
      (capability) => isOwner || held.has(capability),
      (module) => bought.has(module),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantedKey, modulesKey, isOwner])

  /**
   * ONE open section, not a set of them.
   *
   * The set accumulated: every route change added its section and nothing ever
   * removed one, so moving through four sections in a session left four open
   * and the menu three screens long. An accordion keeps it to one screen no
   * matter how long somebody has been working.
   */
  const [open, setOpen] = useState<string | null>(() => sectionForPath(pathname, visible))

  /**
   * The path this sidebar has already settled an open section for.
   *
   * A ref rather than a boolean flag: Strict Mode invokes an effect twice on
   * mount, and a fire-once flag is consumed by the first pass while React
   * discards the state that pass set — so the second pass returns early and the
   * remembered group never comes back. Keyed by path, the second pass reaches
   * the same conclusion as the first, which is what makes it idempotent.
   */
  const settledFor = useRef<string | null>(null)

  // Read the stored preference after mount. Reading it during render would make
  // the server and client markup disagree and blow up hydration.
  useEffect(() => {
    const stored = readStored()
    if (stored?.collapsed) setCollapsed(true)
  }, [])

  /**
   * Which section is open: the one holding this page, or failing that the one
   * left open last time.
   *
   * Both rules live in ONE effect deliberately. Split across two they raced —
   * the restore ran, the route effect ran in the same commit, and which won
   * depended on their order rather than on what either meant. Here the priority
   * is written down: the route wins when it names a section, and the remembered
   * one fills the gap on a route that names none (the dashboard, a hub).
   */
  useEffect(() => {
    const active = sectionForPath(pathname, visible)
    if (active) {
      setOpen(active)
      settledFor.current = pathname
      return
    }
    /* Only on ARRIVAL at such a route, so that closing the group by hand is not
       undone by the next render putting the remembered one back. */
    if (settledFor.current === pathname) return
    settledFor.current = pathname
    const remembered = readStored()?.open
    // A section this user can no longer see is dropped rather than opening nothing.
    if (remembered && visible.some((s) => s.label === remembered)) setOpen(remembered)
  }, [pathname, visible])

  const persist = (next: Partial<Stored>) => {
    try {
      const current = readStored() ?? { collapsed, open }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...next }))
    } catch {
      // Not worth failing the click over.
    }
  }

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v
      persist({ collapsed: next })
      return next
    })
  }

  /**
   * Ctrl+K — or ⌘K on a Mac — from anywhere in the app.
   *
   * On `window` rather than the sidebar, because the point is that it works while
   * somebody is halfway down a product list with focus in a table. Bound here
   * anyway: the sidebar is rendered once by the layout and already holds the
   * palette's state, so a second component to own one shortcut would be a second
   * thing that can disagree about whether it is open.
   *
   * "/" is deliberately NOT bound. This app is full of text fields, and a shop
   * owner typing a customer's address would open a search palette mid-word.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'k' && event.key !== 'K') return
      if (!event.ctrlKey && !event.metaKey) return
      // Not preventing the browser's own Ctrl+K when a modifier we don't own is
      // also held — Ctrl+Shift+K is a devtools shortcut in several browsers.
      if (event.shiftKey || event.altKey) return
      event.preventDefault()
      setSearchOpen((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggleSection = (label: string) =>
    setOpen((prev) => {
      const next = prev === label ? null : label
      persist({ open: next })
      return next
    })

  /**
   * Longest match wins, not every match. A section can hold both /sales and
   * /sales/cashup, and a plain prefix test would light up "Documents" on top of
   * "Cash-up" — two rows highlighted for one page. Computed across the whole
   * menu rather than per section, since the winner may live in another one:
   * /customers/age-analysis and /credit sit under Customers, but /credit's own
   * children could just as easily have been split across sections.
   */
  const activeHref = useMemo(() => {
    /* A screen a hub lists highlights ITS HUB, whatever its URL happens to be
       under. /staff/pay-rules is a setup screen that lives beneath /staff, and a
       plain prefix scan would light "People" while the breadcrumb above said
       "Setup › Pay rules" — the menu and the trail disagreeing about where
       somebody is. */
    const owner = hubFor(pathname)
    if (owner) return visible.some((s) => s.href === owner) ? owner : null

    let best: string | null = null
    for (const section of visible) {
      const hrefs = [section.href, ...(section.items ?? []).map((i) => i.href)]
      for (const href of hrefs) {
        if (!href) continue
        if (pathname !== href && !pathname.startsWith(`${href}/`)) continue
        if (!best || href.length > best.length) best = href
      }
    }
    return best
  }, [pathname, visible])

  const isActive = (href: string) => href === activeHref

  return (
    <aside
      className={`relative z-40 flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Logo + collapse */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
        {!collapsed && (
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            {/* The real mark, same as the till's open-tables gate — this used to
                be a bordered <span> standing in for it. Decorative beside the
                wordmark text, so no alt of its own. */}
            <Image
              src="/logo-icon.png"
              alt=""
              aria-hidden
              width={318}
              height={278}
              unoptimized
              className="h-8 w-auto shrink-0 object-contain"
            />
            {/* Set in the LOGO's own face, not the UI stack: it sits directly
                against the mark and the two have to read as one lockup.

                `.wordmark-lockup`, not `.wordmark` — this is the name standing
                alone in the rail rather than a title beside the artwork, and it
                wants open tracking to read as a wordmark. See globals.css.

                "AI" carries the brand blue and 700 against the name's 800: the
                colour alone was already doing the separating, and leaving both
                halves at the same weight made the blue look like an accident of
                markup rather than the second word of the name. */}
            <span className="wordmark-lockup truncate text-xl leading-none text-ink">
              Odyssey <span className="font-bold text-brand">AI</span>
            </span>
          </Link>
        )}
        <Button
          variant="bare"
          size="sm"
          iconOnly
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <PanelLeft size={18} />
        </Button>
      </div>

      {/*
        A BUTTON that opens the palette, not a field that filters the menu.

        It looks like an input because that is what it does — you click it and
        type — but it cannot be one: the results are pages AND customers AND
        products, and there is nowhere in a 256px rail to show them. Filtering the
        menu in place could only ever find the menu's own rows, which is why
        searching "gratuity" used to find nothing and searching a customer's name
        found nothing at all.

        data-kit-ok: an input-shaped button. Neither a Button variant (all of
        which are controls with their own chrome) nor an Input (which would take
        the keystrokes here instead of in the palette) is this thing.
      */}
      <div className="px-3 pb-3">
        <button
          data-kit-ok
          type="button"
          onClick={() => setSearchOpen(true)}
          title="Search everything (Ctrl+K)"
          aria-label="Search everything"
          className={`flex h-control w-full items-center rounded-control border border-border-strong bg-surface text-sm text-faint transition hover:border-brand/50 ${
            collapsed ? 'justify-center px-0' : 'gap-2 px-3'
          }`}
        >
          <Search size={15} className="shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 truncate text-left">Search</span>
              {/* The shortcut, shown rather than hidden in a tooltip — it is the
                  fastest way in and nobody discovers it otherwise. */}
              <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
                Ctrl K
              </kbd>
            </>
          )}
        </button>
      </div>

      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        sections={visible}
      />


      {/* `overflow-y-auto` also clips horizontally, which would cut a flyout off
          at the rail's edge. The collapsed rail is 9 icon rows and never needs
          to scroll, so it drops the clipping and lets the panel escape. */}
      <nav className={`flex-1 px-2 pb-2 ${collapsed ? 'overflow-visible' : 'overflow-y-auto'}`}>
        {/* The whole menu, always. It is no longer filtered by anything: search
            happens in the palette, so the menu's job is only to be the menu —
            which means it never rearranges itself under somebody mid-click. */}
        {visible.map((section) => (
          <SectionRow
            key={section.label}
            section={section}
            collapsed={collapsed}
            expanded={open === section.label}
            onToggle={() => toggleSection(section.label)}
            isActive={isActive}
          />
        ))}
      </nav>

      {/* The "Need help?" card that used to sit here moved to the Help button in
          the top bar: 90px of permanent chrome at the foot of a menu is the
          opposite of quietening one, and the link is the same either way. */}
    </aside>
  )
}

function SectionRow({
  section,
  collapsed,
  expanded,
  onToggle,
  isActive,
}: {
  section: NavSection
  collapsed: boolean
  expanded: boolean
  onToggle: () => void
  isActive: (href: string) => boolean
}) {
  const Icon = section.icon
  const hasChildren = (section.items?.length ?? 0) > 0
  const selfActive = section.href ? isActive(section.href) : false
  const childActive = (section.items ?? []).some((i) => isActive(i.href))
  const active = selfActive || childActive

  /* The flyout is the collapsed rail's ONLY way to reach a child. Without it a
     narrow sidebar reached one destination out of thirty — the group rows were
     buttons that toggled something with nowhere to render. */
  const [flyout, setFlyout] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Collapsing or expanding the rail should never leave a flyout stranded.
  useEffect(() => setFlyout(false), [collapsed])

  useEffect(() => {
    if (!flyout) return
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setFlyout(false)
    }
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setFlyout(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [flyout])

  const rowClass = `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
    active ? 'bg-brand/10 font-medium text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'
  }`

  // A section that is itself a destination — Dashboard, and every hub.
  if (section.href) {
    /* Plain href, no query string. The palette links straight to the screen
       somebody picked, so a hub no longer has to be opened pre-filtered as a
       consolation prize for the search not being able to name its contents. */
    return (
      <Link
        href={section.href}
        title={collapsed ? section.label : undefined}
        aria-current={selfActive ? 'page' : undefined}
        className={`${rowClass} ${collapsed ? 'justify-center px-0' : ''}`}
      >
        <Icon size={17} className="shrink-0" />
        {!collapsed && <span className="truncate">{section.label}</span>}
      </Link>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      {/* Deliberately not <Button>: this is a nav row that must render
          identically to the sibling <Link> above, which shares rowClass. A
          Button variant would give it button chrome the link cannot match. */}
      <button
        data-kit-ok
        type="button"
        onClick={() => (collapsed ? setFlyout((v) => !v) : onToggle())}
        title={collapsed ? section.label : undefined}
        aria-expanded={collapsed ? flyout : expanded}
        aria-haspopup={collapsed ? 'menu' : undefined}
        className={`${rowClass} ${collapsed ? 'justify-center px-0' : ''}`}
      >
        <Icon size={17} className="shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-left">{section.label}</span>
            <ChevronDown
              size={15}
              className={`shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
            />
          </>
        )}
      </button>

      {/* ── collapsed: the children as a panel beside the rail ───────────── */}
      {collapsed && flyout && (
        <div
          role="menu"
          aria-label={section.label}
          /* ml-3, not ml-1: the row sits inside the nav's own px-2, so
             `left-full` stops short of the rail's edge and a smaller offset
             leaves the panel overlapping the icons it belongs to. */
          className="absolute left-full top-0 z-50 ml-3 w-56 rounded-card border border-border bg-surface p-1.5 shadow-pop"
        >
          <p className="px-2 pb-1.5 pt-1 text-xs font-semibold text-ink">{section.label}</p>
          {hasChildren ? (
            section.items!.map((item) => (
              <ChildLink
                key={item.href}
                item={item}
                isActive={isActive}
                onNavigate={() => setFlyout(false)}
              />
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted opacity-60">Not built yet</p>
          )}
        </div>
      )}

      {/* ── expanded: the children inline ────────────────────────────────── */}
      {!collapsed && expanded && hasChildren && (
        // The rail echoes the screenshot and makes the nesting readable without
        // indenting the labels off the edge.
        <div className="ml-5 border-l border-border pl-2">
          {section.items!.map((item) => (
            <ChildLink key={item.href} item={item} isActive={isActive} />
          ))}
        </div>
      )}

      {!collapsed && expanded && !hasChildren && (
        <p className="ml-5 border-l border-border py-1.5 pl-5 text-xs text-muted opacity-60">
          Not built yet
        </p>
      )}
    </div>
  )
}

/**
 * One child row, rendered identically inline and in a flyout.
 *
 * Shared so the collapsed rail cannot drift into looking like a different menu
 * from the expanded one — they are the same destinations either way.
 */
function ChildLink({
  item,
  isActive,
  onNavigate,
}: {
  item: NavItem
  isActive: (href: string) => boolean
  onNavigate?: () => void
}) {
  const ItemIcon = item.icon
  const itemActive = isActive(item.href)

  if (!item.built) {
    return (
      <span
        title="Not built yet"
        aria-disabled
        className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-muted opacity-45"
      >
        <ItemIcon size={15} className="shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
    )
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={itemActive ? 'page' : undefined}
      /* The till and the invoicing window both open BESIDE the back office
         rather than replacing it — see lib/openTill.ts for why each gets its
         own named target. Spread LAST so it cannot be undone above. */
      {...(item.href === TILL_HREF ? tillLinkProps : {})}
      {...(opensInInvoicingWindow(item.href) ? invoicingLinkProps : {})}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition ${
        itemActive ? 'font-medium text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'
      }`}
    >
      <ItemIcon size={15} className="shrink-0" />
      <span className="truncate">{item.label}</span>
      {itemActive && <span className="ml-auto size-1.5 rounded-full bg-brand" />}
    </Link>
  )
}

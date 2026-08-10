'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { PanelLeft, Search, ChevronDown, HelpCircle as CircleHelp, ArrowRight } from '@/components/ui/icons'
import { Button, ButtonLink, Input } from '@/components/ui'
import { NAV, filterNav, navFor, subpageMatches, type NavSection } from '@/lib/nav'

const STORAGE_KEY = 'odyssey.sidebar.collapsed'

/**
 * The section containing this path, so it opens on load.
 *
 * Longest href wins rather than first declared, for the same reason the
 * highlight uses it: /sales sits in Sales and /setup/laybys in Setup, so a
 * first-match scan would open the wrong group for the deeper route.
 */
function sectionForPath(pathname: string): string | null {
  let best: { label: string; length: number } | null = null

  for (const section of NAV) {
    const hrefs = [section.href, ...(section.items ?? []).map((i) => i.href)]
    for (const href of hrefs) {
      if (!href) continue
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
export default function Sidebar({ granted, isOwner }: { granted: string[]; isOwner: boolean }) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => {
    const active = sectionForPath(pathname)
    return new Set(active ? [active] : [])
  })

  // Read the stored preference after mount. Reading it during render would make
  // the server and client markup disagree and blow up hydration.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true)
    } catch {
      // Private mode or blocked storage — the default is fine.
    }
  }, [])

  // Keep the active section open as the route changes.
  useEffect(() => {
    const active = sectionForPath(pathname)
    if (active) setOpen((prev) => (prev.has(active) ? prev : new Set(prev).add(active)))
  }, [pathname])

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        // Not worth failing the click over.
      }
      return next
    })
  }

  const visible = useMemo(() => {
    const held = new Set(granted)
    return navFor((capability) => isOwner || held.has(capability))
  }, [granted, isOwner])

  const sections = useMemo(() => filterNav(term, visible), [term, visible])
  // While searching, show every matching section expanded — collapsed groups
  // would hide the very results the search just found.
  const searching = term.trim().length > 0

  const toggleSection = (label: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
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
      className={`flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Logo + collapse */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
        {!collapsed && (
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-brand" />
            <span className="truncate text-sm font-bold tracking-wide text-ink">ODYSSEY</span>
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

      {!collapsed && (
        <div className="px-3 pb-3">
          <Input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search pages, reports, settings"
            aria-label="Search navigation"
            icon={<Search size={15} />}
          />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sections.length === 0 && !collapsed && (
          <p className="px-3 py-6 text-center text-xs text-muted">Nothing matches “{term}”.</p>
        )}

        {sections.map((section) => (
          <SectionRow
            key={section.label}
            section={section}
            collapsed={collapsed}
            expanded={searching || open.has(section.label)}
            onToggle={() => toggleSection(section.label)}
            isActive={isActive}
            term={term}
          />
        ))}
      </nav>

      {!collapsed && (
        <div className="p-3">
          <div className="rounded-xl bg-brand/5 p-4 text-center">
            <div className="flex items-center justify-center gap-1.5">
              <CircleHelp size={15} className="text-brand" />
              <span className="text-sm font-semibold text-ink">Need help?</span>
            </div>
            <p className="mt-1 text-xs text-muted">Visit our help centre or contact support.</p>
            {/* The guide is a static file under public/, so it needs a real
                navigation rather than a client-side route change — hence
                prefetch={false} and its own tab, which also means a
                half-finished capture on this screen survives reading the help. */}
            <ButtonLink
              href="/help.html"
              target="_blank"
              rel="noopener"
              prefetch={false}
              variant="primary"
              size="sm"
              className="mt-3 w-full justify-between"
            >
              Go to Help Centre
              <ArrowRight size={14} />
            </ButtonLink>
          </div>
        </div>
      )}
    </aside>
  )
}

function SectionRow({
  section,
  collapsed,
  expanded,
  onToggle,
  isActive,
  term,
}: {
  section: NavSection
  collapsed: boolean
  expanded: boolean
  onToggle: () => void
  isActive: (href: string) => boolean
  /** The live search term, so a hub row can carry it through. */
  term: string
}) {
  const Icon = section.icon
  const hasChildren = (section.items?.length ?? 0) > 0
  const selfActive = section.href ? isActive(section.href) : false
  const childActive = (section.items ?? []).some((i) => isActive(i.href))
  const active = selfActive || childActive

  const rowClass = `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
    active ? 'bg-brand/10 font-medium text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'
  }`

  // A section that is itself a destination, e.g. Dashboard.
  if (section.href) {
    /* This row survived the search only because a screen BELOW it matched —
       Setup, whose settings the menu no longer lists. Hand the term to the hub
       so it opens filtered to what was actually being looked for, rather than
       showing all fourteen and making them type it a second time. The href the
       highlight compares against is untouched. */
    const carry = term.trim() && !section.items?.length && subpageMatches(section.href, term)
    const href = carry ? `${section.href}?q=${encodeURIComponent(term.trim())}` : section.href

    return (
      <Link
        href={href}
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
    <div>
      {/* Deliberately not <Button>: this is a nav row that must render
          identically to the sibling <Link> above, which shares rowClass. A
          Button variant would give it button chrome the link cannot match. */}
      <button
        data-kit-ok
        type="button"
        onClick={onToggle}
        title={collapsed ? section.label : undefined}
        aria-expanded={expanded}
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

      {!collapsed && expanded && hasChildren && (
        // The rail echoes the screenshot and makes the nesting readable without
        // indenting the labels off the edge.
        <div className="ml-5 border-l border-border pl-2">
          {section.items!.map((item) => {
            const ItemIcon = item.icon
            const itemActive = isActive(item.href)

            if (!item.built) {
              return (
                <span
                  key={item.href}
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
                key={item.href}
                href={item.href}
                aria-current={itemActive ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition ${
                  itemActive
                    ? 'font-medium text-brand'
                    : 'text-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <ItemIcon size={15} className="shrink-0" />
                <span className="truncate">{item.label}</span>
                {itemActive && <span className="ml-auto size-1.5 rounded-full bg-brand" />}
              </Link>
            )
          })}
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

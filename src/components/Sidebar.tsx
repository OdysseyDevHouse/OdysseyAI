'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { PanelLeft, Search, ChevronDown, HelpCircle as CircleHelp, ArrowRight } from '@/components/ui/icons'
import { Button, Input } from '@/components/ui'
import { NAV, filterNav, navFor, type NavSection } from '@/lib/nav'

const STORAGE_KEY = 'odyssey.sidebar.collapsed'

/** The section containing this path, so it opens on load. */
function sectionForPath(pathname: string): string | null {
  for (const section of NAV) {
    if (section.href && pathname.startsWith(section.href)) return section.label
    for (const item of section.items ?? []) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return section.label
    }
  }
  return null
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

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

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
            <Button variant="primary" size="sm" className="mt-3 w-full justify-between">
              Go to Help Centre
              <ArrowRight size={14} />
            </Button>
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

  const rowClass = `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
    active ? 'bg-brand/10 font-medium text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'
  }`

  // A section that is itself a destination, e.g. Dashboard.
  if (section.href) {
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

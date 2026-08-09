'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CategoryTile,
  EmptyState,
  Icons,
  SegmentedControl,
  ToolbarSearch,
} from '@/components/ui'
import type { SetupGroup, SetupIconName, SetupItem } from './catalogue'

type ViewMode = 'grid' | 'list'

/**
 * Everything under Setup on one screen.
 *
 * Setup is the section people visit rarely and under pressure — a new till on a
 * Saturday, a rate change the week it takes effect. So the screen optimises for
 * FINDING rather than browsing: the search matches descriptions and keywords as
 * well as labels, because somebody looking for "vat" is not looking for a
 * screen called "Price types", and somebody looking for "pin" wants Users.
 *
 * The grid is the default because these fourteen entries are unfamiliar to most
 * people who open them, and a tile with its one-line description is what makes
 * an unfamiliar thing choosable. The list is for the person who already knows.
 */
export default function SetupHub({
  groups,
  initialSearch = '',
}: {
  groups: SetupGroup[]
  /** From `?q=`, so a search begun in the sidebar carries on here. */
  initialSearch?: string
}) {
  const [search, setSearch] = useState(initialSearch)
  const [view, setView] = useState<ViewMode>('grid')

  const query = search.trim().toLowerCase()

  /**
   * Groups with non-matching tiles removed, and empty groups dropped. Matching
   * on the group's own label too, so "system" surfaces everything filed there
   * rather than nothing.
   */
  const visible = useMemo(() => {
    if (!query) return groups
    return groups.flatMap((group) => {
      if (group.label.toLowerCase().includes(query)) return [group]
      const items = group.items.filter((item) => matches(item, query))
      return items.length ? [{ ...group, items }] : []
    })
  }, [groups, query])

  const total = useMemo(() => visible.reduce((n, g) => n + g.items.length, 0), [visible])

  if (groups.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No settings available"
          hint="Your role does not include access to any setup screen. An owner can grant this under Roles & permissions."
          icon={<Icons.Lock size={28} strokeWidth={1.75} />}
        />
      </Card>
    )
  }

  return (
    <>
      {/* ── toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1 sm:max-w-md">
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Search settings…"
            className="w-full"
            aria-label="Search settings"
          />
        </div>

        <div className="ml-auto">
          <SegmentedControl
            aria-label="How to show the settings"
            value={view}
            onChange={(v) => setView(v as ViewMode)}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
      </div>

      {total === 0 ? (
        <Card>
          <EmptyState
            title={`Nothing matches “${search}”`}
            hint="Try a different word, or clear the search."
            icon={<Icons.Search size={28} strokeWidth={1.75} />}
            action={
              <Button variant="secondary" onClick={() => setSearch('')}>
                Clear search
              </Button>
            }
          />
        </Card>
      ) : view === 'grid' ? (
        <div className="flex flex-col gap-6">
          {visible.map((group) => (
            <GroupGrid key={group.label} group={group} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((group) => (
            <GroupList key={group.label} group={group} />
          ))}
        </div>
      )}
    </>
  )
}

function matches(item: SetupItem, query: string) {
  return (
    item.label.toLowerCase().includes(query) ||
    item.description.toLowerCase().includes(query) ||
    (item.keywords ?? '').toLowerCase().includes(query)
  )
}

/* ── grid view ─────────────────────────────────────────────────────────── */

/**
 * A group as a heading over a row of tiles.
 *
 * The heading is plain text rather than a card, so the tiles themselves are the
 * only boxes on the screen — nesting cards inside cards is what makes a hub
 * read as busy.
 */
function GroupGrid({ group }: { group: SetupGroup }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <CategoryTile icon={glyph(group.icon, 16)} tone={group.tone} size="sm" />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-ink">{group.label}</h2>
          <p className="truncate text-xs text-muted">{group.description}</p>
        </div>
        <Badge tone="neutral">{group.items.length}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {group.items.map((item) => (
          <SettingTile key={item.href} item={item} />
        ))}
      </div>
    </section>
  )
}

/** One setting as a card: what it is called, and what it decides. */
function SettingTile({ item }: { item: SetupItem }) {
  return (
    <Link
      href={item.href}
      className="group flex items-start gap-3 rounded-card border border-border bg-surface px-4 py-3.5 outline-none transition-colors hover:border-border-strong hover:bg-surface-2"
    >
      <CategoryTile icon={glyph(item.icon, 18)} tone={item.tone} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {item.label}
          </span>
          <Icons.ChevronRight
            size={15}
            className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
          />
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{item.description}</span>
      </span>
    </Link>
  )
}

/* ── list view ─────────────────────────────────────────────────────────── */

/** The same catalogue as rows — for someone who knows the name already. */
function GroupList({ group }: { group: SetupGroup }) {
  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
        <CategoryTile icon={glyph(group.icon)} tone={group.tone} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
          {group.label}
        </h2>
        <Badge tone="neutral">{group.items.length}</Badge>
      </div>

      <div className="flex flex-col divide-y divide-border">
        {group.items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex items-center gap-3 px-4 py-2 outline-none transition-colors hover:bg-surface-2"
          >
            <CategoryTile icon={glyph(item.icon, 15)} tone={item.tone} size="sm" />
            <span className="min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-4 sm:flex">
              <span className="min-w-0 truncate text-sm font-medium text-ink-2 group-hover:text-ink sm:w-56">
                {item.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{item.description}</span>
            </span>
            <Icons.ChevronRight
              size={15}
              className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        ))}
      </div>
    </Card>
  )
}

/* ── icons ─────────────────────────────────────────────────────────────── */

/**
 * Name → glyph, resolved here rather than in the catalogue: the catalogue is
 * imported by a server component, and a Lucide component cannot be serialised
 * across the boundary as a prop.
 */
function glyph(name: SetupIconName, size = 18) {
  const Icon = ICONS[name]
  return <Icon size={size} strokeWidth={1.7} />
}

const ICONS: Record<SetupIconName, typeof Icons.Settings> = {
  Users: Icons.Users,
  KeyRound: Icons.KeyRound,
  Store: Icons.Store,
  Warehouse: Icons.Warehouse,
  Percent: Icons.Percent,
  CreditCard: Icons.CreditCard,
  Terminal: Icons.Terminal,
  Hash: Icons.Hash,
  Check: Icons.Check,
  FileText: Icons.FileText,
  Package: Icons.Package,
  Scale: Icons.Scale,
  Database: Icons.Database,
  Palette: Icons.Palette,
  Settings: Icons.Settings,
  ShieldCheck: Icons.ShieldCheck,
  Coins: Icons.Coins,
}

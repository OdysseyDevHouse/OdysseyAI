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
  Tabs,
  ToolbarSearch,
  hubGlyph as glyph,
} from '@/components/ui'
import type { HubGroup, HubItem } from '@/lib/hub'

type ViewMode = 'grid' | 'list'

/** The "everything" tab. Not a group label, so it cannot collide with one. */
const ALL = 'all'

/**
 * A whole section on one screen.
 *
 * This is what a section becomes once it is too big for the menu — Setup first,
 * then Accounting and the Online Store. Those sections are visited rarely and
 * under pressure: a new till on a Saturday, a VAT return the week it is due. So
 * the screen optimises for FINDING rather than browsing — the search matches
 * descriptions and keywords as well as labels, because somebody looking for
 * "vat" is not looking for a screen called "Price types", and somebody looking
 * for "pin" wants Users.
 *
 * The grid is the default because these entries are unfamiliar to most people
 * who open them, and a tile with its one-line description is what makes an
 * unfamiliar thing choosable. The list is for the person who already knows.
 *
 * `tabs` adds a tab per group for the hubs long enough to need one. It narrows
 * BROWSING only — search still reads the whole catalogue, because somebody
 * typing "vat" does not know which group holds the answer, and a tab that hid
 * the hit would be the search reporting the setting does not exist.
 *
 * One component for every hub, so the three cannot drift into looking like
 * three different products.
 */
export default function HubView({
  groups,
  noun,
  emptyHint,
  initialSearch = '',
  tabs = false,
}: {
  groups: HubGroup[]
  /** What these screens are called collectively, for the search box and empties. */
  noun: string
  /** What to tell somebody whose role grants them none of this. */
  emptyHint: string
  /** From `?q=`, so a search begun in the sidebar carries on here. */
  initialSearch?: string
  /**
   * Show a tab per group, with "All" first.
   *
   * Opt-in rather than automatic, because it earns its place only once a hub
   * is long enough that the whole catalogue no longer fits on a screen — Setup
   * has eight groups and fifty-odd tiles, so reaching Loyalty means scrolling
   * past everything that decides what a sale costs. Accounting and the Online
   * Store are one screenful each; a tab bar over them is a control that filters
   * nothing away.
   */
  tabs?: boolean
}) {
  const [search, setSearch] = useState(initialSearch)
  const [view, setView] = useState<ViewMode>('grid')
  const [tab, setTab] = useState<string>(ALL)

  const query = search.trim().toLowerCase()

  /**
   * Groups with non-matching tiles removed, and empty groups dropped. Matching
   * on the group's own label too, so "system" surfaces everything filed there
   * rather than nothing.
   */
  const found = useMemo(() => {
    if (!query) return groups
    return groups.flatMap((group) => {
      if (group.label.toLowerCase().includes(query)) return [group]
      const items = group.items.filter((item) => matches(item, query))
      return items.length ? [{ ...group, items }] : []
    })
  }, [groups, query])

  /**
   * The tabs, counted AFTER the search — so a search says how many hits each
   * group holds, and a group the search has emptied still shows as an empty
   * tab rather than vanishing and shifting every other tab sideways under the
   * pointer.
   */
  const tabItems = useMemo(() => {
    if (!tabs) return []
    const hits = new Map(found.map((g) => [g.label, g.items.length]))
    return [
      { value: ALL, label: 'All', count: found.reduce((n, g) => n + g.items.length, 0) },
      ...groups.map((group) => ({
        value: group.label,
        label: group.label,
        icon: glyph(group.icon, 16),
        count: hits.get(group.label) ?? 0,
      })),
    ]
  }, [tabs, groups, found])

  /* A tile the search found under another tab is a tile the searcher cannot
     see, so searching returns to All rather than reporting nothing. */
  const active = !tabs || query ? ALL : tab

  const visible = useMemo(
    () => (active === ALL ? found : found.filter((g) => g.label === active)),
    [found, active],
  )

  const total = useMemo(() => visible.reduce((n, g) => n + g.items.length, 0), [visible])

  if (groups.length === 0) {
    return (
      <Card>
        <EmptyState
          title={`No ${noun} available`}
          hint={emptyHint}
          icon={<Icons.Lock size={28} strokeWidth={1.75} />}
        />
      </Card>
    )
  }

  /* One tab is showing one group, and the tab already names it — so the
     heading would say the same word twice, a foot apart. The description is
     the half worth keeping, and it moves up beside the tabs. */
  const only = active === ALL ? null : (visible[0] ?? null)

  return (
    <>
      {tabs && (
        <Tabs
          items={tabItems}
          value={active}
          onChange={setTab}
          aria-label={`Which ${noun} to show`}
        />
      )}

      {/* ── toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1 sm:max-w-md">
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder={`Search ${noun}…`}
            className="w-full"
            aria-label={`Search ${noun}`}
          />
        </div>

        <div className="ml-auto">
          <SegmentedControl
            aria-label={`How to show the ${noun}`}
            value={view}
            onChange={(v) => setView(v as ViewMode)}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
      </div>

      {only && <p className="-mt-1 text-sm text-muted">{only.description}</p>}

      {total === 0 ? (
        <Card>
          {query ? (
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
          ) : (
            /* Reachable only with tabs on: a group whose every tile this role
               cannot open is dropped upstream, so the tab exists but is bare. */
            <EmptyState
              title={`No ${noun} here`}
              hint={emptyHint}
              icon={<Icons.Lock size={28} strokeWidth={1.75} />}
              action={
                <Button variant="secondary" onClick={() => setTab(ALL)}>
                  Show all
                </Button>
              }
            />
          )}
        </Card>
      ) : view === 'grid' ? (
        <div className="flex flex-col gap-6">
          {visible.map((group) => (
            <GroupGrid key={group.label} group={group} heading={!only} />
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

function matches(item: HubItem, query: string) {
  return (
    item.label.toLowerCase().includes(query) ||
    item.description.toLowerCase().includes(query) ||
    (item.keywords ?? '').toLowerCase().includes(query)
  )
}

/**
 * Where a tile goes, and what makes it unique in a list.
 *
 * Almost always just the route. A tile carrying an `anchor` is the exception —
 * a second door onto a screen that is genuinely two jobs, landing on the half
 * that was asked for (see `anchor` in lib/hub.ts). The hash is also what keeps
 * the React key distinct: two tiles sharing a route would otherwise share a
 * key, and React would drop one of them.
 */
function tileHref(item: HubItem): string {
  return item.anchor ? `${item.href}#${item.anchor}` : item.href
}

/* ── grid view ─────────────────────────────────────────────────────────── */

/**
 * A group as a heading over a row of tiles.
 *
 * The heading is plain text rather than a card, so the tiles themselves are the
 * only boxes on the screen — nesting cards inside cards is what makes a hub
 * read as busy.
 */
function GroupGrid({ group, heading = true }: { group: HubGroup; heading?: boolean }) {
  return (
    <section className="flex flex-col gap-3">
      {heading && (
        <div className="flex items-center gap-3">
          <CategoryTile icon={glyph(group.icon, 16)} tone={group.tone} size="sm" />
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{group.label}</h2>
            <p className="truncate text-xs text-muted">{group.description}</p>
          </div>
          <Badge tone="neutral">{group.items.length}</Badge>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {group.items.map((item) => (
          <ScreenTile key={tileHref(item)} item={item} />
        ))}
      </div>
    </section>
  )
}

/** One screen as a card: what it is called, and what it decides. */
function ScreenTile({ item }: { item: HubItem }) {
  return (
    <Link
      href={tileHref(item)}
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
function GroupList({ group }: { group: HubGroup }) {
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
            key={tileHref(item)}
            href={tileHref(item)}
            className="group flex items-center gap-3 px-4 py-2 outline-none transition-colors hover:bg-surface-2"
          >
            <CategoryTile icon={glyph(item.icon, 15)} tone={item.tone} size="sm" />
            <span className="min-w-0 flex-1 flex-col sm:flex sm:flex-row sm:items-center sm:gap-4">
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

/* The name → glyph map moved to the kit (components/ui/hubIcons.tsx): the global
   search palette renders catalogue rows too, and two copies of a 37-entry map is
   two things to update when a catalogue names a new icon. */

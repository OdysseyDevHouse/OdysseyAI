'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CategoryTile,
  EmptyState,
  FavoriteToggle,
  Icons,
  SegmentedControl,
  Tabs,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import {
  categoryDescription,
  categoryIcon,
  categoryTone,
  sourceIcon,
  sourceTone,
} from './categoryStyle'
import { toggleFavoriteAction } from './actions'

export type HubItem = {
  id: string
  name: string
  description: string
  category: string
  /** The dataset behind it, which gives the tile its own glyph and hue. */
  source: string
  kind: 'builtin' | 'builder' | 'ask'
  createdByName: string
  /** A saved spec that no longer validates — listed so it can be removed. */
  broken: boolean
}

type ViewMode = 'grid' | 'list'

/** The "everything" tab. Not a category name, so it cannot collide with one. */
const ALL = '__all'

/**
 * The order the category tabs sit in.
 *
 * Fixed rather than alphabetical, and it deliberately matches the sidebar's own
 * running order — Sales, Stock, Customers, Suppliers, Money, Operations — so
 * somebody who knows where things live in the menu finds the same sequence
 * here. Saved sits after those because it is the shop's own work rather than a
 * subject; anything unlisted lands at the end rather than silently first.
 */
const CATEGORY_ORDER = [
  'Sales',
  'Stock',
  'Customers',
  'Suppliers',
  'Money',
  'Operations',
  'Multi-store',
  'Job cards',
  'Saved',
]

function categoryRank(category: string) {
  const i = CATEGORY_ORDER.indexOf(category)
  return i === -1 ? CATEGORY_ORDER.length : i
}

/**
 * The catalogue.
 *
 * Built to the same shape as Setup and Accounting (`src/components/HubView.tsx`)
 * — a plain group heading over a grid of description tiles, and a list view of
 * rows for someone who already knows the name. The three sections are the same
 * kind of screen and were reading as three different products; a report is no
 * less unfamiliar to someone opening it for the first time than a setup screen
 * is, and the description is what makes an unfamiliar thing choosable.
 *
 * Not shared with `HubView` outright, because this hub carries two things the
 * others have no notion of: per-user FAVOURITES, which sit above everything
 * because a shop runs the same four reports every morning out of a catalogue of
 * forty-five; and a toolbar that can build, schedule and generate. The layout is
 * matched deliberately rather than by inheritance — if `HubView` gains a
 * favourites slot, this should collapse into it.
 */
export default function ReportsHub({
  templates,
  saved,
  favorites,
  canBuild,
  canSchedule,
  canUseAi,
  emptyHint,
}: {
  templates: HubItem[]
  saved: HubItem[]
  favorites: string[]
  canBuild: boolean
  canSchedule: boolean
  canUseAi: boolean
  /**
   * What to say when there is nothing at all to list. The Job cards cut needs a
   * different sentence from the main hub's — "your role grants no reports" is
   * the wrong answer for somebody who simply has no job reports.
   */
  emptyHint?: string
}) {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<string>(ALL)
  const [view, setView] = useState<ViewMode>('grid')
  const [favs, setFavs] = useState<Set<string>>(() => new Set(favorites))
  const [, startTransition] = useTransition()
  const toast = useToast()

  const all = useMemo(() => [...saved, ...templates], [saved, templates])
  const query = search.trim().toLowerCase()

  const matches = useMemo(() => {
    if (!query) return all
    return all.filter(
      (i) =>
        i.name.toLowerCase().includes(query) ||
        i.description.toLowerCase().includes(query) ||
        i.category.toLowerCase().includes(query),
    )
  }, [all, query])

  const favouriteItems = useMemo(() => all.filter((i) => favs.has(i.id)), [all, favs])

  /**
   * The categories present, in CATEGORY_ORDER.
   *
   * Taken from the FULL catalogue, deliberately — not from the search results.
   *
   * Deriving these from `matches` was the obvious thing and it is wrong: typing
   * in the search box then rewrites the tab bar itself. Tabs disappear as their
   * category stops matching, the bar changes width, and the highlight is left on
   * a tab that no longer exists. A navigation control that reshapes itself while
   * being read is not navigable. So the bar is a STABLE structure, and the
   * search filters within it.
   *
   * Still derived from the data rather than from CATEGORY_ORDER alone, for two
   * reasons: a shop whose role hides Money should not be offered an empty tab,
   * and this same component renders the Job cards screen where one category is
   * all there is.
   */
  const categories = useMemo(() => {
    const present = [...new Set(all.map((i) => i.category))]
    present.sort((a, b) => categoryRank(a) - categoryRank(b))
    return present
  }, [all])

  /* A stored tab naming a category this role cannot see falls back to All
     rather than to a blank screen. Computed, so nothing has to chase state. */
  const activeTab = tab !== ALL && categories.includes(tab) ? tab : ALL

  /*
   * Tab first, then search — and a search that finds nothing in the selected
   * tab widens to the whole catalogue rather than showing an empty screen.
   *
   * Without that widening, searching "cashier" while Stock is selected shows
   * nothing at all, even though the shop plainly has cashier reports; the tab is
   * a browsing choice, and someone who has started typing a name has stopped
   * browsing. `searchedWider` tells the reader that is what happened, so the
   * results never look like they came from the tab they can see selected.
   */
  const inTab = useMemo(
    () => (activeTab === ALL ? matches : matches.filter((i) => i.category === activeTab)),
    [matches, activeTab],
  )
  const searchedWider = Boolean(query) && activeTab !== ALL && inTab.length === 0 && matches.length > 0
  const visible = searchedWider ? matches : inTab

  /** Grouped by category, preserving the catalogue's own ordering. */
  const groups = useMemo(() => {
    const out = new Map<string, HubItem[]>()
    for (const item of visible) {
      const list = out.get(item.category) ?? []
      list.push(item)
      out.set(item.category, list)
    }
    return [...out.entries()]
  }, [visible])

  /* One tab per category, then All at the end as asked. Name and glyph only —
     no counts: the bar is for choosing where to look, and eight numbers across
     it compete with the eight words that actually say what is there. Each
     category's own heading still carries its count on the All tab. */
  const tabItems = useMemo(
    () => [
      ...categories.map((name) => ({
        value: name,
        label: name,
        icon: categoryIcon(name, 15),
      })),
      { value: ALL, label: 'All', icon: <Icons.LayoutGrid size={15} strokeWidth={1.7} /> },
    ],
    [categories],
  )

  function onToggleFavorite(id: string) {
    // Optimistic: the star must feel instant, and the only failure mode is a
    // star that flips back, which the toast explains.
    const previous = favs
    const next = new Set(favs)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFavs(next)

    startTransition(async () => {
      const result = await toggleFavoriteAction(id)
      if (!result.ok) {
        setFavs(previous)
        toast.error(result.error)
      }
    })
  }

  if (all.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No reports available"
          hint={
            emptyHint ??
            'Your role does not include access to any report data yet. An owner can grant this under Setup → Roles.'
          }
          icon={<Icons.BarChart size={28} strokeWidth={1.75} />}
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
            placeholder="Search reports…"
            className="w-full"
            aria-label="Search reports"
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label="How to show the catalogue"
            value={view}
            onChange={(v) => setView(v as ViewMode)}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'list', label: 'List' },
            ]}
          />
          {canSchedule && (
            <ButtonLink href="/reports/schedules" variant="ghost">
              <Icons.Clock size={16} />
              Scheduled
            </ButtonLink>
          )}
          {canUseAi && (
            <ButtonLink href="/reports/ask" variant="secondary">
              <Icons.Sparkles size={16} />
              Generate with AI
            </ButtonLink>
          )}
          {canBuild && (
            <ButtonLink href="/reports/builder" variant="primary">
              <Icons.Plus size={16} />
              Build a report
            </ButtonLink>
          )}
        </div>
      </div>

      {/* ── favourites shelf ─────────────────────────────────────────────── */}
      {!query && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <CategoryTile
              icon={<Icons.Star size={16} strokeWidth={1.7} />}
              tone="amber"
              size="sm"
            />
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold text-ink">Your reports</h2>
              <p className="truncate text-xs text-muted">
                The ones you have starred, ready for tomorrow morning.
              </p>
            </div>
            {favouriteItems.length > 0 && <Badge tone="neutral">{favouriteItems.length}</Badge>}
          </div>

          {favouriteItems.length === 0 ? (
            <div className="rounded-card border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm text-muted">
                Star any report and it will sit here, ready for tomorrow morning.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {favouriteItems.map((item) => (
                <ReportTile key={item.id} item={item} starred onToggle={onToggleFavorite} />
              ))}
            </div>
          )}
        </section>
      )}

      {/*
        ── category tabs ──────────────────────────────────────────────────
        Only worth a bar when there is more than one category to switch
        between: the Job cards screen renders this same component with a
        single category, where a one-tab bar plus All is furniture that
        filters nothing.
      */}
      {categories.length > 1 && (
        <Tabs
          items={tabItems}
          value={activeTab}
          onChange={setTab}
          aria-label="Report category"
        />
      )}

      {/* Said plainly, because otherwise results from other categories appear
          under a tab the reader can see is still selected. */}
      {searchedWider && (
        <p className="text-xs text-muted">
          Nothing in {activeTab} matches “{search.trim()}” — showing every category.
        </p>
      )}

      {/* ── the catalogue ────────────────────────────────────────────────── */}
      {matches.length === 0 ? (
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
          {groups.map(([category, items]) => (
            <CategoryGrid
              key={category}
              category={category}
              items={items}
              favs={favs}
              onToggle={onToggleFavorite}
              /* On a single-category tab the selected tab already names the
                 section; repeating it as a heading directly underneath is the
                 same word twice for no information. The description still
                 shows, since that does say something the tab cannot. When the
                 search has widened past the tab, headings come back — the
                 results span categories and need naming again. */
              showHeading={activeTab === ALL || searchedWider}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([category, items]) => (
            <CategoryList
              key={category}
              category={category}
              items={items}
              favs={favs}
              onToggle={onToggleFavorite}
            />
          ))}
        </div>
      )}
    </>
  )
}

/* ── grid view ─────────────────────────────────────────────────────────── */

/**
 * A category as a heading over a row of tiles.
 *
 * The heading is plain text rather than a card, so the tiles are the only boxes
 * on the screen — nesting cards inside cards is what makes a hub read as busy.
 */
function CategoryGrid({
  category,
  items,
  favs,
  onToggle,
  showHeading = true,
}: {
  category: string
  items: HubItem[]
  favs: Set<string>
  onToggle: (id: string) => void
  /** False when a selected tab already names this category — see the caller. */
  showHeading?: boolean
}) {
  const description = categoryDescription(category)

  return (
    <section className="flex flex-col gap-3">
      {showHeading ? (
        <div className="flex items-center gap-3">
          <CategoryTile icon={categoryIcon(category, 16)} tone={categoryTone(category)} size="sm" />
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{category}</h2>
            {description && <p className="truncate text-xs text-muted">{description}</p>}
          </div>
          <Badge tone="neutral">{items.length}</Badge>
        </div>
      ) : (
        description && <p className="text-xs text-muted">{description}</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {items.map((item) => (
          <ReportTile
            key={item.id}
            item={item}
            starred={favs.has(item.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * One report as a card: what it is called, and what it answers.
 *
 * The star sits above the card's own click target rather than inside it — an
 * overlay link makes the whole tile clickable, and the star is lifted back out
 * of it so it stays separately hittable.
 */
function ReportTile({
  item,
  starred,
  onToggle,
}: {
  item: HubItem
  starred: boolean
  onToggle: (id: string) => void
}) {
  return (
    <div className="group relative flex items-start gap-3 rounded-card border border-border bg-surface px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-surface-2">
      <CategoryTile icon={sourceIcon(item.source)} tone={sourceTone(item.source)} />
      <Link
        href={`/reports/${encodeURIComponent(item.id)}`}
        className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-card after:content-['']"
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {item.name}
          </span>
          {item.kind === 'ask' && <Icons.Sparkles size={12} className="shrink-0 text-brand" />}
          {item.broken && <Badge tone="warning">Needs attention</Badge>}
        </span>
        {/* The full sentence, wrapping. It was briefly clipped to one line with
            the rest on hover, back when every category sat on one page and the
            ragged tile heights were the loudest thing on the screen. The tabs
            fixed that at the source — a tab shows a dozen tiles, not eighty —
            so the description can simply be readable again. */}
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{item.description}</span>
      </Link>
      <span className="relative z-10">
        <FavoriteToggle starred={starred} onToggle={() => onToggle(item.id)} label={item.name} />
      </span>
    </div>
  )
}

/* ── list view ─────────────────────────────────────────────────────────── */

/** The same catalogue as rows — for someone who knows the name already. */
function CategoryList({
  category,
  items,
  favs,
  onToggle,
}: {
  category: string
  items: HubItem[]
  favs: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
        <CategoryTile icon={categoryIcon(category)} tone={categoryTone(category)} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{category}</h2>
        <Badge tone="neutral">{items.length}</Badge>
      </div>

      <div className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <div
            key={item.id}
            className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2"
          >
            <CategoryTile
              icon={sourceIcon(item.source, 15)}
              tone={sourceTone(item.source)}
              size="sm"
            />
            <Link
              href={`/reports/${encodeURIComponent(item.id)}`}
              className="min-w-0 flex-1 flex-col outline-none sm:flex sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="min-w-0 truncate text-sm font-medium text-ink-2 group-hover:text-ink sm:w-56">
                {item.name}
              </span>
              {/* Still one truncated line here, unlike the grid: a list row IS
                  a single line by construction, and wrapping it would turn the
                  rows into blocks and lose the scannability that is the whole
                  reason for the list view. */}
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{item.description}</span>
            </Link>
            {item.kind === 'ask' && (
              <Badge tone="brand">
                <Icons.Sparkles size={11} />
                AI
              </Badge>
            )}
            {item.broken && <Badge tone="warning">Needs attention</Badge>}
            <FavoriteToggle
              starred={favs.has(item.id)}
              onToggle={() => onToggle(item.id)}
              label={item.name}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

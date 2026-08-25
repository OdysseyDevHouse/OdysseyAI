'use client'

import { useMemo, useState, useSyncExternalStore, useTransition } from 'react'
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
  Tooltip,
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
  /**
   * Where the tile goes, for the handful of entries that are a PAGE rather than
   * a spec the engine runs — the audit trail is one. Omitted means the engine
   * route, which is what every catalogue and saved report uses.
   */
  href?: string
  /**
   * A page that cannot be starred, because favourites are keyed on report ids
   * and a page has no spec behind that id.
   */
  unstarrable?: boolean
}

/** The tile's destination: a page's own route, or the engine's. */
function itemHref(item: HubItem) {
  return item.href ?? `/reports/${encodeURIComponent(item.id)}`
}

type ViewMode = 'grid' | 'list'

/** The "everything" tab. Not a category name, so it cannot collide with one. */
const ALL = '__all'

/**
 * The "popular" tab — the handful of reports a shop actually opens.
 *
 * Underscored for the same reason ALL is: it is a VIEW over the catalogue
 * rather than a category, so it can never collide with a real category name.
 *
 * It DUPLICATES rather than moves, deliberately. Invoice history is a Sales
 * report whether or not it is also popular, and somebody browsing Sales for it
 * must still find it there. So this tab owns no items: it filters the same
 * catalogue by id, and every tile is the same tile — same star, same route.
 * That is also why the ids live on the SERVER (see `POPULAR_REPORTS` in
 * `page.tsx`) and arrive as a prop: an id naming a report this role may not run
 * is simply not in the catalogue, so it lists nothing rather than a dead tile.
 */
const POPULAR = '__popular'

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
  /* Directly after Sales, because it is the same subject asked a different way:
     Sales is WHAT the shop sold, Performance is WHO AND WHAT earned it. It has
     no sidebar entry of its own to match, so it is placed by meaning — and the
     two tabs are read together often enough that separating them would cost a
     trip across the bar. */
  'Performance',
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

/* ── laying the panels out in columns ──────────────────────────────────────
 *
 * See the note at the grid itself for why this is done in JS rather than with
 * CSS `columns`. In short: CSS fills a column top-to-bottom before moving
 * across, which permutes the category running order; this keeps it.
 */

/**
 * The breakpoints the panel grid uses, as pixel widths.
 *
 * These MUST match the `lg:grid-cols-2 2xl:grid-cols-3` on the grid — the
 * columns are built here but drawn by those classes, so a mismatch means
 * panels dealt into three columns and rendered in two, which strands the third
 * column's contents in a stack at the bottom. Tailwind's own values.
 */
const LG = 1024
const XXL = 1536

/** Subscribe to a media query, SSR-safe. */
function useMediaQuery(query: string): boolean {
  const [mq] = useState(() =>
    typeof window === 'undefined' ? null : window.matchMedia(query),
  )
  return useSyncExternalStore(
    (onChange) => {
      if (!mq) return () => {}
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => (mq ? mq.matches : false),
    /* The SERVER snapshot, and it must be a stable `false`: the server cannot
       know the viewport, so it renders the one-column case and the client
       corrects on mount. Returning `mq.matches` here would differ between the
       two renders and trip a hydration mismatch. */
    () => false,
  )
}

/**
 * How many columns the grid is currently drawing.
 *
 * One before mount and on a narrow screen, which is also what the server
 * renders — so the first paint is a single ordered stack, which is correct at
 * any width rather than merely unstyled.
 */
function useColumnCount(): number {
  const wide = useMediaQuery(`(min-width: ${XXL}px)`)
  const medium = useMediaQuery(`(min-width: ${LG}px)`)
  return wide ? 3 : medium ? 2 : 1
}

/**
 * Deal items into `count` columns, in order, keeping the top row in reading
 * order and the columns roughly level.
 *
 * The first `count` items go one per column — that is what puts Sales,
 * Performance and Stock across the top row. After that each item joins
 * whichever column is currently shortest, so a tall panel does not drag its
 * column far past the others. Height is approximated by the number of reports
 * a panel holds, which is what actually drives it.
 */
function balance<T>(items: readonly T[], count: number, weigh: (item: T) => number): T[][] {
  const columns: T[][] = Array.from({ length: count }, () => [])
  const heights = new Array<number>(count).fill(0)

  items.forEach((item, i) => {
    /* The first row is positional, not balanced: it is the running order, and
       levelling it would be the very reordering this exists to prevent. */
    const target =
      i < count ? i : heights.indexOf(Math.min(...heights))
    columns[target].push(item)
    /* A constant per panel for its header and padding, so three short panels
       are not treated as cheaper than one panel of the same total rows. */
    heights[target] += weigh(item) + 3
  })

  return columns
}

/** What to CALL a tab in prose — the sentinels are not words. */
function tabLabel(tab: string) {
  if (tab === POPULAR) return 'Popular'
  if (tab === ALL) return 'All'
  return tab
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
  popular = [],
  canBuild,
  canSchedule,
  canUseAi,
  emptyHint,
}: {
  templates: HubItem[]
  saved: HubItem[]
  favorites: string[]
  /**
   * Report ids to also list under a Popular tab, in the order they should show.
   *
   * Optional, and empty means no tab at all — the Job cards screen renders this
   * same component over fifteen reports, where singling out five of them says
   * nothing.
   */
  popular?: string[]
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
  const columnCount = useColumnCount()
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
   * The popular reports, in the order they were named rather than the
   * catalogue's — the list IS an editorial running order, so it is walked
   * outwards from `popular` and not filtered inwards from `all`.
   *
   * An id naming a report this role cannot run finds nothing and drops out,
   * which is why nothing here needs a permission check of its own.
   */
  const popularItems = useMemo(() => {
    const byId = new Map(all.map((i) => [i.id, i]))
    return popular.map((id) => byId.get(id)).filter((i): i is HubItem => i !== undefined)
  }, [all, popular])

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
     rather than to a blank screen — and so does Popular on a screen that was
     given no popular ids. Computed, so nothing has to chase state. */
  const activeTab =
    tab === POPULAR
      ? popularItems.length > 0
        ? POPULAR
        : ALL
      : tab !== ALL && categories.includes(tab)
        ? tab
        : ALL

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
  const inTab = useMemo(() => {
    if (activeTab === ALL) return matches
    /* Popular selects by id, not category — and keeps the editorial order,
       which is why it walks `popularItems` and tests membership of the search
       results rather than the other way round. */
    if (activeTab === POPULAR) {
      const found = new Set(matches.map((i) => i.id))
      return popularItems.filter((i) => found.has(i.id))
    }
    return matches.filter((i) => i.category === activeTab)
  }, [matches, activeTab, popularItems])
  const searchedWider = Boolean(query) && activeTab !== ALL && inTab.length === 0 && matches.length > 0
  const visible = searchedWider ? matches : inTab

  /**
   * Grouped by category, preserving the catalogue's own ordering.
   *
   * Except on Popular, which is ONE section under its own heading. Grouping
   * there would break five hand-picked reports into three headed sections of
   * one or two — which is the catalogue the reader just chose to step out of,
   * and it would throw away the running order they were given in.
   */
  /* Typed rather than inferred: the Popular branch below returns a single
     fixed pair and would otherwise infer a narrower tuple than the general
     branch, which `balance` cannot take as one type. */
  const groups = useMemo<[string, HubItem[]][]>(() => {
    if (activeTab === POPULAR && !searchedWider) return [[POPULAR, visible]]
    const out = new Map<string, HubItem[]>()
    for (const item of visible) {
      const list = out.get(item.category) ?? []
      list.push(item)
      out.set(item.category, list)
    }
    return [...out.entries()]
  }, [visible, activeTab, searchedWider])

  /* Popular first, then one tab per category, then All at the end as asked.
     Name and glyph only — no counts: the bar is for choosing where to look, and
     eight numbers across it compete with the eight words that actually say what
     is there. Each category's own heading still carries its count on the All
     tab.

     Popular leads because it is the shortest path to the thing most people came
     for; putting it after the subjects would mean scanning past everything it
     exists to save you from. */
  const tabItems = useMemo(
    () => [
      ...(popularItems.length > 0
        ? [{ value: POPULAR, label: 'Popular', icon: categoryIcon(POPULAR, 15) }]
        : []),
      ...categories.map((name) => ({
        value: name,
        label: name,
        icon: categoryIcon(name, 15),
      })),
      { value: ALL, label: 'All', icon: <Icons.LayoutGrid size={15} strokeWidth={1.7} /> },
    ],
    [categories, popularItems],
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
            /*
             * Each favourite is its own TILE, not a row.
             *
             * The rows below draw no box of their own — they rely on the
             * category panel around them for their edges, which is right when
             * a dozen sit in a list under one heading. The shelf has no such
             * panel: a handful of rows in one wide card ran together as a
             * single strip, with nothing to say where one report ended and the
             * next began.
             *
             * So these carry their own border and surface, and the grid gaps
             * separate them. They are the shortcuts somebody uses every
             * morning — they should look like things to press.
             */
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {favouriteItems.map((item) => (
                <FavouriteTile key={item.id} item={item} onToggle={onToggleFavorite} />
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
      {(categories.length > 1 || popularItems.length > 0) && (
        <Tabs
          items={tabItems}
          value={activeTab}
          onChange={setTab}
          aria-label="Report category"
        />
      )}

      {/* Said plainly, because otherwise results from other categories appear
          under a tab the reader can see is still selected. Named through
          `tabLabel` so the Popular tab does not report itself as `__popular`. */}
      {searchedWider && (
        <p className="text-xs text-muted">
          Nothing in {tabLabel(activeTab)} matches “{search.trim()}” — showing every category.
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
        /*
         * Category CARDS, side by side — each subject its own panel of rows.
         *
         * ── WHY THE COLUMNS ARE BUILT IN JS ─────────────────────────────────
         *
         * Two layouts are wrong here, and this is the third.
         *
         * A plain GRID lays out in rows, so every panel beside Sales is stranded
         * at the top of a row as deep as the tallest panel in it, and the page
         * fills with empty gaps.
         *
         * CSS `columns` fixes the gaps but reorders the reading: it fills each
         * column top-to-bottom before moving across, so the running order
         * Sales, Performance, Stock… lands as a FIRST ROW of Sales, Stock,
         * Suppliers, with Performance hidden under Sales. The order is
         * meaningful — Performance sits second because it is read with Sales —
         * and a layout that silently permutes it is not showing that order.
         *
         * So the panels are dealt into columns here, in order, and each column
         * is rendered as a plain flex stack. The top row reads across as the
         * first three categories, and the columns still pack by height because
         * `balance` puts each panel in whichever column is currently shortest.
         */
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {balance(groups, columnCount, ([, items]) => items.length).map((column, i) => (
            <div key={i} className="flex flex-col gap-4">
              {column.map(([category, items]) => (
                <CategoryGrid
                  key={category}
                  category={category}
                  items={items}
                  favs={favs}
                  onToggle={onToggleFavorite}
                />
              ))}
            </div>
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
 * A category as a CARD: its name and count in a header, its reports as rows.
 *
 * ── WHY A CARD OF ROWS RATHER THAN A ROW OF TILES ──────────────────────────
 *
 * The subject is the thing being chosen first. Somebody arriving at this hub
 * knows they want a stock figure long before they know which stock report, and
 * a flat field of eighty equal tiles makes them read every name to find where
 * one subject ends and the next begins. Boxing each subject turns that into two
 * decisions: pick the panel, then read the handful of names inside it.
 *
 * It also lets the subjects sit SIDE BY SIDE. As full-width bands of tiles, six
 * categories were a very long page whose lower half nobody scrolled to; as
 * columns, most of the catalogue is on one screen.
 *
 * The cost is nesting — a card inside a card — which is what the old flat
 * layout was avoiding, and the reason the rows inside carry no borders or
 * surfaces of their own. The panel is the only box; a row is text that
 * highlights when pointed at.
 */
function CategoryGrid({
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
  const description = categoryDescription(category)

  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <CategoryTile icon={categoryIcon(category, 16)} tone={categoryTone(category)} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{tabLabel(category)}</h2>
          {description && <p className="truncate text-xs text-muted">{description}</p>}
        </div>
        {/* The count belongs in the header rather than on a row: it says how
            much is in this panel, which is exactly the thing being decided. */}
        <Badge tone="neutral">{items.length}</Badge>
      </div>

      <div className="flex flex-col p-1.5">
        {items.map((item) => (
          <ReportTile
            key={item.id}
            item={item}
            starred={favs.has(item.id)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </Card>
  )
}

/**
 * One report as a ROW inside its category's card: its name, a chevron, a star —
 * and, on hover, what it answers.
 *
 * ── WHY THE DESCRIPTION IS NOT ON THE FACE ─────────────────────────────────
 *
 * A catalogue of eighty reports whose every entry carries a full sentence is
 * eighty sentences to read past, and the NAME is what a reader scans by; the
 * sentence only matters for the one they have already narrowed down to. In a
 * card of rows there is nowhere to put it anyway without turning each row into
 * a paragraph and the panel into a page. So it moves into a tooltip the whole
 * row raises — the text is there for the one report being considered, and costs
 * nothing for the seventy-nine that are not.
 *
 * `trigger="card"` and not the default, which would silently never appear: the
 * overlay link below covers the row (`after:absolute inset-0`) so it can be
 * clicked anywhere, and nothing underneath that overlay ever receives `:hover`.
 * Reacting to the row's own hover is the only thing that works without
 * dismantling the overlay — see Tooltip's note. The panel stays
 * `pointer-events-none`, so it cannot swallow the click from the link under it.
 *
 * `side="bottom"` because these rows are stacked: a tooltip opening upwards
 * from the second row covers the first, which is the row the reader just
 * rejected and may want back. Downwards it covers rows they have not reached.
 *
 * The star sits above the row's own click target rather than inside it — the
 * overlay makes the whole row clickable, and the star is lifted back out of it
 * so it stays separately hittable.
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
    <div className="group relative flex items-center gap-2.5 rounded-control px-2.5 py-1.5 transition-colors hover:bg-surface-2">
      <Tooltip
        label={item.description}
        trigger="card"
        side="bottom"
        align="start"
        className="min-w-0 flex-1"
      >
        <Link
          href={itemHref(item)}
          className="block min-w-0 outline-none after:absolute after:inset-0 after:rounded-control after:content-['']"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2 group-hover:text-ink">
              {item.name}
            </span>
            {item.kind === 'ask' && <Icons.Sparkles size={12} className="shrink-0 text-brand" />}
            {item.broken && <Badge tone="warning">Needs attention</Badge>}
          </span>
        </Link>
      </Tooltip>
      {/* Points the way in, and gives the eye a right-hand edge to run down.
          Faint until the row is pointed at — eighty of these at full strength
          would be the loudest thing on the screen. */}
      <Icons.ChevronRight
        size={14}
        className="shrink-0 text-faint transition-colors group-hover:text-muted"
        aria-hidden
      />
      {!item.unstarrable && (
        <span className="relative z-10">
          <FavoriteToggle starred={starred} onToggle={() => onToggle(item.id)} label={item.name} />
        </span>
      )}
    </div>
  )
}

/**
 * One starred report on the shelf, as a tile that stands on its own.
 *
 * ── WHY THIS IS NOT `ReportTile` WITH A BORDER ─────────────────────────────
 *
 * They answer different questions. A row in a category panel is one of a dozen
 * being SCANNED under a heading that already says what they have in common, so
 * it carries a name and nothing else, and the panel draws the edges. A
 * favourite is being RECOGNISED and pressed — there are three or four, they
 * come from different categories, and there is no panel around them.
 *
 * So this one keeps the source glyph, which is the fastest way to tell a stock
 * report from a sales one when they sit side by side with no heading to group
 * them. The rows drop it precisely because inside Stock every glyph is the
 * same and it says nothing.
 *
 * The star is always filled and always on: everything here is starred by
 * definition, and it is the way back OUT — pressing it removes the report from
 * the shelf, which is the only un-starring anyone does deliberately.
 */
function FavouriteTile({
  item,
  onToggle,
}: {
  item: HubItem
  onToggle: (id: string) => void
}) {
  return (
    <div className="group relative flex items-center gap-3 rounded-card border border-border bg-surface px-3.5 py-3 shadow-card transition-colors hover:border-border-strong hover:bg-surface-2">
      <CategoryTile icon={sourceIcon(item.source, 15)} tone={sourceTone(item.source)} size="sm" />
      <Tooltip
        label={item.description}
        trigger="card"
        side="bottom"
        align="start"
        className="min-w-0 flex-1"
      >
        <Link
          href={itemHref(item)}
          className="block min-w-0 outline-none after:absolute after:inset-0 after:rounded-card after:content-['']"
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {item.name}
            </span>
            {item.kind === 'ask' && <Icons.Sparkles size={12} className="shrink-0 text-brand" />}
            {item.broken && <Badge tone="warning">Needs attention</Badge>}
          </span>
        </Link>
      </Tooltip>
      {!item.unstarrable && (
        <span className="relative z-10">
          <FavoriteToggle starred onToggle={() => onToggle(item.id)} label={item.name} />
        </span>
      )}
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
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
          {tabLabel(category)}
        </h2>
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
              href={itemHref(item)}
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
            {!item.unstarrable && (
              <FavoriteToggle
                starred={favs.has(item.id)}
                onToggle={() => onToggle(item.id)}
                label={item.name}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

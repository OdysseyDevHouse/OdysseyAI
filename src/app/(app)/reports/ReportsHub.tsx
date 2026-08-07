'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  CategoryTile,
  EmptyState,
  FavoriteToggle,
  Icons,
  SegmentedControl,
  ToolbarSearch,
  useToast,
} from '@/components/ui'
import { categoryIcon, categoryTone } from './categoryStyle'
import { toggleFavoriteAction } from './actions'

export type HubItem = {
  id: string
  name: string
  description: string
  category: string
  kind: 'builtin' | 'builder' | 'ask'
  createdByName: string
  /** A saved spec that no longer validates — listed so it can be removed. */
  broken: boolean
}

type ViewMode = 'grid' | 'list'

/** Reports shown inside a category card before it offers "show all". */
const CARD_MAX = 7

/**
 * The catalogue.
 *
 * Two ideas carry the layout. First, favourites sit ABOVE everything: a shop
 * runs four reports every morning out of a catalogue of thirty, and putting
 * those four at the top is worth more than any amount of categorisation below.
 * Second, a category is a CARD listing report NAMES — not a grid of
 * description tiles. Descriptions are for choosing a report you have never run;
 * names are for finding one you have, which is what people are doing nearly
 * every time. The description moves to the row's tooltip.
 */
export default function ReportsHub({
  templates,
  saved,
  favorites,
  canBuild,
  canSchedule,
  canUseAi,
}: {
  templates: HubItem[]
  saved: HubItem[]
  favorites: string[]
  canBuild: boolean
  canSchedule: boolean
  canUseAi: boolean
}) {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [favs, setFavs] = useState<Set<string>>(() => new Set(favorites))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
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

  /** Grouped by category, preserving the catalogue's own ordering. */
  const groups = useMemo(() => {
    const out = new Map<string, HubItem[]>()
    for (const item of matches) {
      const list = out.get(item.category) ?? []
      list.push(item)
      out.set(item.category, list)
    }
    return [...out.entries()]
  }, [matches])

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
          hint="Your role does not include access to any report data yet. An owner can grant this under Setup → Roles."
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
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink">Your reports</h2>
            {favouriteItems.length > 0 && <Badge tone="neutral">{favouriteItems.length}</Badge>}
          </div>

          {favouriteItems.length === 0 ? (
            <div className="rounded-card border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm text-muted">
                Star any report and it will sit here, ready for tomorrow morning.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {favouriteItems.map((item) => (
                <FavouriteCard
                  key={item.id}
                  item={item}
                  starred
                  onToggle={onToggleFavorite}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── the catalogue ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink">
            {query ? 'Matching reports' : 'All reports'}
          </h2>
          <Badge tone="neutral">{matches.length}</Badge>
        </div>

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
        ) : view === 'list' ? (
          <div className="flex flex-col gap-5">
            {groups.map(([category, items]) => (
              <CategoryTable
                key={category}
                category={category}
                items={items}
                favs={favs}
                onToggle={onToggleFavorite}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {groups.map(([category, items]) => (
              <CategoryCard
                key={category}
                category={category}
                items={items}
                favs={favs}
                onToggle={onToggleFavorite}
                expanded={expanded.has(category) || !!query}
                onShowAll={() =>
                  setExpanded((s) => {
                    const next = new Set(s)
                    next.add(category)
                    return next
                  })
                }
              />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

/* ── grid view ─────────────────────────────────────────────────────────── */

/**
 * One category as a card: a coloured tile, the title, a count, then the report
 * names. Long categories truncate — but only when it saves more than one row,
 * because hiding a single report behind "show all" is just a worse list.
 */
function CategoryCard({
  category,
  items,
  favs,
  onToggle,
  expanded,
  onShowAll,
}: {
  category: string
  items: HubItem[]
  favs: Set<string>
  onToggle: (id: string) => void
  expanded: boolean
  onShowAll: () => void
}) {
  const truncate = !expanded && items.length > CARD_MAX + 1
  const rows = truncate ? items.slice(0, CARD_MAX) : items

  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
        <CategoryTile icon={categoryIcon(category)} tone={categoryTone(category)} />
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{category}</h3>
        <Badge tone="neutral">{items.length}</Badge>
      </div>

      <div className="flex flex-col p-1.5">
        {rows.map((item) => (
          <ReportRow
            key={item.id}
            item={item}
            starred={favs.has(item.id)}
            onToggle={onToggle}
          />
        ))}
        {truncate && (
          <Button variant="ghost" size="sm" onClick={onShowAll} className="justify-start">
            Show all {items.length} reports
            <Icons.ChevronRight size={14} />
          </Button>
        )}
      </div>
    </Card>
  )
}

/**
 * One report inside a category card.
 *
 * Just the name, because that is what someone scans for. The description is the
 * tooltip — useful the first time, noise every time after.
 */
function ReportRow({
  item,
  starred,
  onToggle,
}: {
  item: HubItem
  starred: boolean
  onToggle: (id: string) => void
}) {
  return (
    <div className="group flex items-center gap-1 rounded-control pr-1.5 pl-3 transition-colors hover:bg-surface-2">
      <Link
        href={`/reports/${encodeURIComponent(item.id)}`}
        title={item.description || undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 outline-none"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2 group-hover:text-ink">
          {item.name}
        </span>
        {item.kind === 'ask' && <Icons.Sparkles size={12} className="shrink-0 text-brand" />}
        {item.broken && <Badge tone="warning">Needs attention</Badge>}
        <Icons.ChevronRight
          size={15}
          className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
        />
      </Link>
      <FavoriteToggle starred={starred} onToggle={() => onToggle(item.id)} label={item.name} />
    </div>
  )
}

/** A favourite as a standalone card, with its category's tile. */
function FavouriteCard({
  item,
  starred,
  onToggle,
}: {
  item: HubItem
  starred: boolean
  onToggle: (id: string) => void
}) {
  return (
    <div className="group relative flex items-center gap-3 rounded-card border border-border bg-surface px-3.5 py-3 transition-colors hover:border-border-strong hover:bg-surface-2">
      <CategoryTile
        icon={categoryIcon(item.category, 16)}
        tone={categoryTone(item.category)}
        size="sm"
      />
      {/* The overlay makes the whole card clickable while the star stays
          separately hittable above it. */}
      <Link
        href={`/reports/${encodeURIComponent(item.id)}`}
        title={item.description || undefined}
        className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-card after:content-['']"
      >
        <span className="block truncate text-sm font-medium text-ink">{item.name}</span>
        <span className="block truncate text-xs text-muted">{item.category}</span>
      </Link>
      <span className="relative z-10">
        <FavoriteToggle starred={starred} onToggle={() => onToggle(item.id)} label={item.name} />
      </span>
    </div>
  )
}

/* ── list view ─────────────────────────────────────────────────────────── */

/**
 * The same catalogue as rows rather than cards — for someone who knows the
 * name and wants the whole lot on one screen, with the descriptions visible.
 */
function CategoryTable({
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
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{category}</h3>
        <Badge tone="neutral">{items.length}</Badge>
      </div>
      <div className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <div
            key={item.id}
            className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2"
          >
            <Link
              href={`/reports/${encodeURIComponent(item.id)}`}
              className="flex min-w-0 flex-1 flex-col outline-none sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="min-w-0 truncate text-sm font-medium text-ink-2 group-hover:text-ink sm:w-64">
                {item.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {item.description}
              </span>
            </Link>
            {item.kind === 'ask' && (
              <Badge tone="brand">
                <Icons.Sparkles size={11} />
                AI
              </Badge>
            )}
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

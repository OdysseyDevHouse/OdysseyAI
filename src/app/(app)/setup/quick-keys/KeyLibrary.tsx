'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import {
  Button,
  Card,
  CardHeader,
  Icons,
  Input,
  ProductTile,
  SegmentedControl,
  Skeleton,
  TileGrid,
  toneForId,
  type CategoryTone,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  QUICK_KEY_ACTIONS,
  quickKeyAllowedOnSection,
  quickKeyAllowedOnTill,
  quickKeySig,
  type QuickKeyRow,
  type QuickKeySection,
  type QuickKeyTarget,
} from '@/lib/quickKeys'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'
import type { TillProduct } from '@/lib/site/tillSearch'
import { browseCatalogueAction } from './actions'

/**
 * The library — everything a bar could hold, on the right, ready to be dragged on.
 *
 * ── WHY A RAIL AND NOT ONLY A MODAL ───────────────────────────────────────
 *
 * Setting a bar up is not one act, it is thirty. A modal is right for "add this one
 * thing" and wrong for "lay out a till": every key costs an open, a choose, a confirm
 * and a dismiss, and the canvas is hidden for all four — so a manager cannot see the
 * thing they are building while they build it.
 *
 * With a rail the whole catalogue is visible beside the canvas and a key costs one drag.
 * The modal stays, because a precise search for one product in forty thousand is still
 * better in a dialog with room for it.
 *
 * ── THE CATALOGUE TABS ARE THE TILL'S CATALOGUE ───────────────────────────
 *
 * Products and Depts are not lists here; they are the same drill a cashier uses, in
 * miniature. Tap a department to open it, walk back out through a breadcrumb or the
 * Back tile, and pick from a grid of tiles carrying the department's own tone, the
 * product's price and the same glyphs.
 *
 * That is the point rather than decoration. A manager is arranging what a cashier will
 * see, and a flat alphabetical list is a different mental model from the tree the till
 * actually draws — so a key that looked sensible in the designer landed on a till laid
 * out nothing like it. Browsing the way the cashier browses means the thing being
 * arranged and the place it lands are one picture.
 *
 * The tiles are narrower than the till's (see TILE_W) because this rail is 320px, not
 * half a counter screen. Same components, same tones, same drill — a smaller pane.
 *
 * ── A NEW KEY IS ALWAYS APPENDED ──────────────────────────────────────────
 *
 * Dropping one is not aimed: wherever it lands, it goes to the end of the open scope.
 * Placing a brand-new key precisely is a second drag, and asking for that precision at
 * the moment of creation makes the common act (get it onto the bar) pay for the rare one
 * (get it exactly there). Reordering afterwards is one drag and already works.
 */

/** A key that does not exist yet, described well enough to create. */
export type NewKeyDraft = {
  target: QuickKeyTarget
  label: string
  icon: string
  colourToken: string
}

/** A department as this rail draws it — the narrowed tree the page ships. */
export type LibraryDepartment = {
  id: number
  parentId: number | null
  name: string
  sortOrder: number
}

/*
 * Tile geometry for a 320px rail.
 *
 * The till browses at 200×150 and steps that with a tile-size setting. Neither figure
 * fits here: 200px wide leaves ONE column inside a card in a 320px column, which turns
 * a grid into a list wearing tile costume. 132px fits two across with the card's own
 * padding and the gap, which is the smallest arrangement that still reads as a grid.
 *
 * The height is below SHORT_TILE_MAX on purpose, so ProductTile flips to its
 * side-by-side layout: at this width a stacked tile has room for a glyph or a name,
 * not both. The short layout drops the subtitle and keeps the name beside the badge
 * with the price under it — which is exactly the pair a manager picks by.
 */
const TILE_W = 132
const TILE_H = 96

export function KeyLibrary({
  keys,
  section,
  hospitality,
  departments,
  busy,
  onAdd,
}: {
  /** Everything already on a bar — so the library can hide what is already placed. */
  keys: readonly QuickKeyRow[]
  section: QuickKeySection
  /** A restaurant till. Decides which actions this shop can use at all. */
  hospitality: boolean
  /** The whole department tree, shipped with the page. See the page's docblock. */
  departments: LibraryDepartment[]
  busy: boolean
  /** Click-to-add. The drag path goes through the canvas's own drop handling. */
  onAdd: (draft: NewKeyDraft) => void
}) {
  const [tab, setTab] = useState<'action' | 'catalogue'>('action')
  const [query, setQuery] = useState('')
  /* The drill, as a PATH rather than a current id — the breadcrumb needs every level
     above, and rebuilding that by walking parents on each render is the same walk done
     worse. Empty means the top of the tree. Exactly how the till holds it. */
  const [path, setPath] = useState<number[]>([])
  const [products, setProducts] = useState<TillProduct[]>([])
  const [loading, setLoading] = useState(false)

  /*
   * Where each already-placed key LIVES, by signature.
   *
   * Not merely "is it placed". A key filed inside a folder is invisible on the bar, so
   * a manager looking for "Cash up" sees a greyed row and an empty canvas and concludes
   * the screen is broken — when in fact the key is two taps away inside Supervisor.
   * Naming the folder answers the question the greyed row provokes.
   *
   * The value is the group's caption, or '' for a key sitting on the bar itself.
   */
  const placedIn = new Map<string, string>()
  for (const k of keys.filter((k) => k.section === section)) {
    const parent = k.parentId === null ? null : keys.find((p) => p.id === k.parentId)
    placedIn.set(k.sig, parent?.caption || '')
  }

  const term = query.trim()
  const currentDept = path.length ? path[path.length - 1] : null

  /*
   * One query serves both browsing and searching, because `browseForTill` takes both
   * and a term typed inside a department should narrow THAT department rather than
   * abandon it. Debounced at 180ms like the till's search and the add modal's.
   *
   * A term shorter than two characters is treated as no term — one letter matches most
   * of a 40,000-line product file, which reads as broken rather than as a search.
   */
  useEffect(() => {
    if (tab !== 'catalogue') return
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      browseCatalogueAction({
        term: term.length >= 2 ? term : undefined,
        /* A search reaches across the WHOLE file rather than the open department. A
           manager who types a product name is looking for that product, not asking
           whether it happens to be filed here — and a search that silently found
           nothing because of where they were standing is the worse failure. */
        departmentId: term.length >= 2 ? null : currentDept,
      })
        .then((rows) => {
          if (!cancelled) setProducts(rows)
        })
        .catch(() => {
          if (!cancelled) setProducts([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tab, term, currentDept])

  const searching = tab === 'catalogue' && term.length >= 2

  const actionRows: NewKeyDraft[] = useMemo(() => {
    const needle = term.toLowerCase()
    return QUICK_KEY_ACTIONS.filter(
      (a) =>
        /* Hidden outright, not greyed — a hospitality shop will never have parked
           baskets, so a permanently dead "Saved sales" row is noise rather than
           information. Contrast the tables-bar rule, which greys and explains, because
           there the key IS available, just on the other bar. */
        !quickKeyAllowedOnTill({ kind: 'action', actionSlug: a.slug }, hospitality),
    )
      .filter(
        (a) =>
          !needle ||
          a.label.toLowerCase().includes(needle) ||
          a.hint.toLowerCase().includes(needle),
      )
      .map((a) => ({
        target: { kind: 'action', actionSlug: a.slug },
        label: a.label,
        icon: a.icon,
        colourToken: 'tile-1',
      }))
  }, [term, hospitality])

  /* Sub-departments of wherever the manager is standing, ordered the way the till
     orders them — one sort rule, so the designer and the counter agree. */
  const children = useMemo(
    () =>
      departments
        .filter((d) => d.parentId === currentDept)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [departments, currentDept],
  )

  /* The trail, resolving each id and dropping any that no longer exists — a department
     deleted in another tab must not leave the breadcrumb pointing at a ghost. */
  const trail = useMemo(
    () => path.map((id) => departments.find((d) => d.id === id)).filter((d) => d !== undefined),
    [departments, path],
  )

  return (
    <Card>
      <CardHeader
        title="Add keys"
        description="Drag one onto the canvas, or click to put it at the end."
      />

      <div className="flex flex-col gap-3 p-4">
        <SegmentedControl
          aria-label="What kind of key"
          value={tab}
          onChange={(next) => {
            setTab(next)
            setQuery('')
            setPath([])
          }}
          /* Two segments where there were three. Products and departments were never
             two different browsing jobs — on the till they are one pane, where a
             department is the thing you tap to reach the products. Splitting them here
             made "put the Coffee department on the bar" and "put a flat white on the
             bar" feel like separate screens, and forced a manager to know which tab a
             thing lived in before they could look for it. */
          options={[
            { value: 'action', label: 'Actions' },
            { value: 'catalogue', label: 'Catalogue' },
          ]}
        />

        <Input
          value={query}
          icon={<Icons.Search size={16} />}
          placeholder={tab === 'catalogue' ? 'Search products…' : 'Filter…'}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
        />

        {tab === 'action' ? (
          <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto">
            {actionRows.length === 0 ? (
              <Note>Nothing matches.</Note>
            ) : (
              actionRows.map((draft) => {
                const sig = quickKeySig(draft.target)
                return (
                  <ActionRow
                    key={sig}
                    draft={draft}
                    sig={sig}
                    /* Already on this bar, or not allowed on it. Both are shown rather
                       than hidden when there is a REASON worth reading — "already on
                       this bar" answers the question a manager is about to ask. */
                    placed={placedIn.has(sig)}
                    /* Which folder it is in, so a key that cannot be found on the
                       canvas says where it went. '' means it is on the bar itself. */
                    placedIn={placedIn.get(sig) ?? ''}
                    banned={quickKeyAllowedOnSection(
                      {
                        kind: 'action',
                        actionSlug: draft.target.kind === 'action' ? draft.target.actionSlug : '',
                      },
                      section,
                    )}
                    busy={busy}
                    onAdd={() => onAdd(draft)}
                  />
                )
              })
            )}
          </div>
        ) : (
          <CatalogueDrill
            trail={trail}
            children={children}
            departments={departments}
            products={products}
            loading={loading}
            searching={searching}
            placedIn={placedIn}
            busy={busy}
            onDrill={(id) => {
              setPath((p) => [...p, id])
              /* A search is abandoned the moment a department is opened. Keeping the
                 term would drill into a department and then show the whole file
                 regardless of it — two instructions on screen, one of them ignored. */
              setQuery('')
            }}
            onDrillTo={setPath}
            onAdd={onAdd}
          />
        )}
      </div>
    </Card>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted">{children}</p>
}

/* ── The catalogue drill ─────────────────────────────────────────────────── */

/**
 * Departments and products in one grid, the way the till draws them.
 *
 * The order is deliberate and matches the counter: the way out first, then the
 * sub-departments, then the products. A manager learns the corner rather than the
 * rule, and it is the same corner a cashier will learn.
 *
 * Unlike the till this shows a department's SUB-DEPARTMENTS AND its products together.
 * On the till that would duplicate — `browseProductsAction` expands a whole subtree, so
 * the products beneath a sub-department would appear both under its tile and under
 * their own. Here it is the point: a manager putting "Coffee" on the bar and a manager
 * putting "Flat white" on the bar are doing the same job, and making them drill to a
 * leaf before they can see either would be a tap spent on nothing.
 */
function CatalogueDrill({
  trail,
  children,
  departments,
  products,
  loading,
  searching,
  placedIn,
  busy,
  onDrill,
  onDrillTo,
  onAdd,
}: {
  trail: LibraryDepartment[]
  children: LibraryDepartment[]
  departments: LibraryDepartment[]
  products: TillProduct[]
  loading: boolean
  /** A term is being searched, so the grid is results rather than a department. */
  searching: boolean
  placedIn: Map<string, string>
  busy: boolean
  onDrill: (id: number) => void
  onDrillTo: (path: number[]) => void
  onAdd: (draft: NewKeyDraft) => void
}) {
  const atTop = trail.length === 0

  return (
    <div className="flex flex-col gap-2.5">
      {/* ── Breadcrumb ──────────────────────────────────────────────────── */}
      {/* Only once there is somewhere to go back to. At the top of the tree a trail
          reading just "All" is a control that does nothing, taking a line of a rail
          that has few to spare. */}
      {!searching && !atTop && (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[13px]">
          <Button variant="bare" size="sm" onClick={() => onDrillTo([])}>
            All
          </Button>
          {trail.map((d, i) => {
            const last = i === trail.length - 1
            return (
              <span key={d.id} className="flex items-center gap-1">
                <span className="text-faint">›</span>
                {last ? (
                  <span className="truncate font-semibold text-ink">{d.name}</span>
                ) : (
                  // Intermediate crumbs are tappable — walking back up one level is
                  // far more common than starting over from the top.
                  <Button
                    variant="bare"
                    size="sm"
                    onClick={() => onDrillTo(trail.slice(0, i + 1).map((t) => t.id))}
                  >
                    {d.name}
                  </Button>
                )}
              </span>
            )
          })}
        </nav>
      )}

      <div className="max-h-[52vh] overflow-y-auto pr-0.5">
        {loading && products.length === 0 && children.length === 0 ? (
          <TileGrid tileWidth={TILE_W} tileHeight={TILE_H}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-full w-full rounded-card" />
            ))}
          </TileGrid>
        ) : searching && products.length === 0 ? (
          <Note>No product matches.</Note>
        ) : !searching && children.length === 0 && products.length === 0 ? (
          <Note>{atTop ? 'No departments or products yet.' : 'Nothing in here.'}</Note>
        ) : (
          <TileGrid tileWidth={TILE_W} tileHeight={TILE_H}>
            {/* The way out, as the first cell — the same corner at every depth, so it
                is found by position rather than read each time. Present only when
                there is somewhere to go: at the top of the tree it would be a tile
                that does nothing, and search has its own way back via the field. */}
            {!searching && !atTop && (
              <ProductTile
                title="Back"
                icon={<Icons.Reverse size={18} />}
                dashed
                tileHeight={TILE_H}
                onClick={() => onDrillTo(trail.slice(0, -1).map((t) => t.id))}
              />
            )}

            {!searching &&
              children.map((d) => {
                const draft: NewKeyDraft = {
                  target: { kind: 'department', departmentId: d.id },
                  label: d.name,
                  icon: '',
                  colourToken: 'tile-1',
                }
                const sig = quickKeySig(draft.target)
                return (
                  <DraggableTile
                    key={sig}
                    draft={draft}
                    sig={sig}
                    placed={placedIn.has(sig)}
                    placedIn={placedIn.get(sig) ?? ''}
                    busy={busy}
                    title={d.name}
                    icon={<Icons.Tag size={18} />}
                    tone={toneForId(d.id)}
                    /* A department tile does two things, so it says both: tapping the
                       tile OPENS it (the chevron), and the corner button puts it on
                       the bar. Without the split, opening "Coffee" to see what is in
                       it and adding "Coffee" as a key would be the same gesture, and
                       a manager exploring the tree would carpet the canvas with keys
                       they never meant to make. */
                    chevron={departments.some((c) => c.parentId === d.id)}
                    onOpen={() => onDrill(d.id)}
                    onAdd={() => onAdd(draft)}
                  />
                )
              })}

            {products.map((p) => {
              const draft: NewKeyDraft = {
                target: { kind: 'product', productId: p.id },
                label: p.description,
                icon: '',
                colourToken: 'tile-1',
              }
              const sig = quickKeySig(draft.target)
              /* The department's tone, so a product tile here carries the same colour
                 it will carry on the till. Falling back to its own id keeps an
                 unfiled product coloured rather than grey — the ramp is an
                 identifier, and one grey tile among coloured ones reads as broken. */
              const tone = toneForId(p.departmentId ?? p.id)
              return (
                <DraggableTile
                  key={sig}
                  draft={draft}
                  sig={sig}
                  placed={placedIn.has(sig)}
                  placedIn={placedIn.get(sig) ?? ''}
                  busy={busy}
                  title={p.description}
                  price={formatMoney(p.priceIncl)}
                  icon={<Icons.Package size={18} />}
                  tone={tone}
                  onAdd={() => onAdd(draft)}
                />
              )
            })}
          </TileGrid>
        )}
      </div>
    </div>
  )
}

/**
 * A catalogue tile that can be dragged onto the canvas, clicked to append, and — for a
 * department — opened.
 *
 * The drag data is the whole draft rather than an id, because the thing being dragged
 * has no id yet: it is not a row until it lands.
 *
 * ── WHY THE ADD BUTTON IS A SEPARATE CORNER TARGET ────────────────────────
 *
 * A product tile has one meaning, so the whole tile adds it. A DEPARTMENT tile has two —
 * open it, or put it on the bar — and one tap cannot honestly mean both. The till
 * resolves the same ambiguity by having no add at all: tapping a department there only
 * ever opens it. Here the tile keeps the till's meaning (tap to open) and the add moves
 * to its own small target, which is the one that is safe to miss.
 */
function DraggableTile({
  draft,
  sig,
  placed,
  placedIn,
  busy,
  title,
  price,
  icon,
  tone,
  chevron = false,
  onOpen,
  onAdd,
}: {
  draft: NewKeyDraft
  sig: string
  placed: boolean
  /** The folder it is in, or '' for the bar itself. Only meaningful when `placed`. */
  placedIn: string
  busy: boolean
  title: string
  price?: string
  icon: React.ReactNode
  tone: CategoryTone
  chevron?: boolean
  /** Departments only. Given, the tile itself drills instead of adding. */
  onOpen?: () => void
  onAdd: () => void
}) {
  const disabled = placed || busy
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new-${sig}`,
    disabled,
    data: { draft },
  })

  /* Only ever "already placed" here. The section rule bans ACTIONS from the tables bar
     and nothing else — a product or a department is legal on either. */
  const why = placed ? (placedIn ? `On this bar, in “${placedIn}”.` : 'On this bar.') : undefined

  return (
    /* Not a kit component: it is a ProductTile wrapped in dnd-kit's listeners with an
       add button laid over its corner, and neither of those can be expressed through
       ProductTile's props. The tile inside is the real kit component — only the
       wrapper and the corner button are local, so the tile itself can never drift
       from the till's. */
    <div
      ref={setNodeRef}
      data-kit-ok
      {...attributes}
      {...listeners}
      title={why}
      /* min-w-0 is load-bearing, not tidiness. This div is the GRID ITEM now that the
         tile is wrapped, and a grid item's default `min-width: auto` refuses to shrink
         below its content's intrinsic width — so a tile holding "Cheesecake — Baked"
         rendered 169px inside a 135px track and the whole grid scrolled sideways. The
         tile itself already carries min-w-0; the wrapper has to as well or it never
         gets the chance to. */
      className={`relative min-w-0 ${disabled ? 'opacity-50' : ''} ${isDragging ? 'opacity-40' : ''}`}
    >
      <ProductTile
        title={title}
        price={price}
        icon={icon}
        tone={tone}
        edge={tone}
        chevron={chevron}
        tileHeight={TILE_H}
        disabled={disabled}
        /* A department opens; a product adds. See the docblock. */
        onClick={onOpen ?? onAdd}
      />

      {/* The add target for a department, over the tile's corner. Products have none —
          their whole tile is the add, and a second way to do the same thing on the
          same tile is one more thing to explain. */}
      {onOpen && !disabled && (
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          type="button"
          className="absolute bottom-1 right-1"
          aria-label={`Add ${title} as a key`}
          title={`Add ${title} as a key`}
          onClick={(e) => {
            /* The tile beneath opens the department; without this the add would open
               it as well and the new key would appear on a canvas the manager has
               just navigated away from. */
            e.stopPropagation()
            onAdd()
          }}
        >
          <Icons.Plus size={14} />
        </Button>
      )}

      {/* Why a tile is dead, said on the tile. A greyed tile with no reason is the
          thing that sends a manager looking for a bug. */}
      {disabled && why && (
        <span className="pointer-events-none absolute inset-x-1 bottom-1 truncate rounded-control bg-surface-2 px-1.5 py-0.5 text-center text-[11px] text-muted">
          {why}
        </span>
      )}
    </div>
  )
}

/* ── The actions list ────────────────────────────────────────────────────── */

/**
 * One action in the library — draggable onto the canvas, clickable to append.
 *
 * Still a ROW rather than a tile, and deliberately so. The catalogue is a tree a
 * manager browses, which is what tiles are for; the actions are a fixed list of about
 * thirty read by name, where a row fits four to a tile's space and the names — "Cash
 * up", "Print bill" — are the whole content. Tiles here would be a grid of text.
 */
function ActionRow({
  draft,
  sig,
  placed,
  placedIn,
  banned,
  busy,
  onAdd,
}: {
  draft: NewKeyDraft
  sig: string
  placed: boolean
  placedIn: string
  banned: string | null
  busy: boolean
  onAdd: () => void
}) {
  const disabled = placed || Boolean(banned) || busy
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new-${sig}`,
    disabled,
    data: { draft },
  })

  const art = quickKeyArt({
    actionSlug: draft.target.kind === 'action' ? draft.target.actionSlug : '',
    icon: draft.icon,
  })
  const Glyph = glyphFor(draft.icon)

  return (
    /* Not a kit control: it is a draggable row that is also a button, and the kit's
       TouchRow cannot carry dnd-kit's listeners onto its own element. */
    <button
      ref={setNodeRef}
      type="button"
      data-kit-ok
      {...attributes}
      {...listeners}
      disabled={disabled}
      onClick={onAdd}
      title={
        banned ??
        (placed
          ? placedIn
            ? `Already on this bar, inside "${placedIn}".`
            : 'Already on this bar.'
          : undefined)
      }
      className={`flex items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-2 text-left transition ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'hover:border-border-strong hover:bg-surface-2'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
        {art ? (
          <img src={quickKeyArtSrc(art.file)} alt="" className="h-5 w-5" />
        ) : Glyph ? (
          <Glyph size={16} />
        ) : (
          <Icons.Sparkles size={16} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{draft.label}</span>
        {(placed || banned) && (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
            {banned ? (
              'Not on this bar'
            ) : placedIn ? (
              /* The folder it went into. A key filed away is invisible on the canvas,
                 so without this the greyed row reads as "already added" over a bar that
                 plainly does not have it — and the manager goes looking for a bug. */
              <>
                <Icons.Shapes size={11} className="shrink-0" />
                <span className="truncate">In “{placedIn}”</span>
              </>
            ) : (
              'On this bar'
            )}
          </span>
        )}
      </span>
      {!disabled && <Icons.Plus size={14} className="shrink-0 text-muted" />}
    </button>
  )
}

function glyphFor(name: string) {
  if (!name) return null
  const set = Icons as unknown as Record<string, typeof Icons.Sparkles>
  return set[name] ?? null
}

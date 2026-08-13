'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  Icons,
  Menu,
  SegmentedControl,
  Select,
  Switch,
  ToolbarSearch,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { OpenTab } from './actions'
import type { PosTable, TableState } from '@/lib/site/posTables'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { VisitType } from '@/lib/site/visitTypes'

/** The "no filter" segment. A string because every other segment key is one. */
const ALL_VISITS = 'ALL'

/* ── the gate's tile grid: how many tables fit across ────────────────────────
   A PER-DEVICE preference, not a shop setting: the same restaurant runs a 22"
   touchscreen at the pass (7 tables across) and a small till at the bar (3). So
   it lives in this browser's localStorage and the Customize menu next to
   Refresh sets it. Tiles shrink in HEIGHT as they shrink in width, so the cards
   stay in proportion instead of turning into tall thin slivers at 7-across.

   Hiding the total is the same kind of preference: some floors want the running
   tab on the tile, others want more tables on screen and drop it to buy back
   the height. */
const COLUMN_CHOICES = [3, 4, 5, 6, 7] as const
const TILE_MAX_H = 168
const TILE_H_STEP = 9
/** Past this many across, a tile is too narrow for the roomy type — step the
 *  text and icons down a size so the content still fits. */
const DENSE_FROM_COLS = 7
/** What "Hide total" takes off a tile: the whole footer — the divider and its
 *  margins, plus the total/chevron row under it. Subtracted from the tile's
 *  minimum height, so the cards actually CLOSE UP instead of keeping the space
 *  they no longer fill. */
const TILE_TOTAL_H = 64

const TABLE_COLS_KEY = 'pos-table-cols'
const TABLE_HIDE_TOTAL_KEY = 'pos-table-hide-total'
/** "floor" | "list" — which Tables view this device opens on. */
const TABLE_VIEW_KEY = 'pos-table-view'

/** How this device likes its table tiles laid out — set from Customize. */
interface TablePrefs {
  cols: number
  hideTotal: boolean
  /**
   * Floor plan or the flat list. A DEVICE preference, like the columns above:
   * the big screen at the pass wants the room, the small till at the bar wants
   * the list. Defaults to the list — a shop with no plan drawn must never open
   * on an empty floor, and the toggle only appears when a plan exists.
   */
  view: 'list' | 'floor'
}

/** The gate's tile-layout preferences, persisted for this device. */
function useTablePrefs(): [TablePrefs, (patch: Partial<TablePrefs>) => void] {
  const [prefs, setPrefs] = useState<TablePrefs>({
    cols: COLUMN_CHOICES[0],
    hideTotal: false,
    view: 'list',
  })

  // Hydrate after mount — reading localStorage during render would mismatch SSR.
  useEffect(() => {
    try {
      const cols = Number(window.localStorage.getItem(TABLE_COLS_KEY))
      setPrefs({
        cols: (COLUMN_CHOICES as readonly number[]).includes(cols)
          ? cols
          : COLUMN_CHOICES[0],
        hideTotal: window.localStorage.getItem(TABLE_HIDE_TOTAL_KEY) === '1',
        view:
          window.localStorage.getItem(TABLE_VIEW_KEY) === 'floor' ? 'floor' : 'list',
      })
    } catch {
      // Storage blocked (private mode / locked-down kiosk) — keep the defaults.
    }
  }, [])

  function update(patch: Partial<TablePrefs>) {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      try {
        window.localStorage.setItem(TABLE_COLS_KEY, String(next.cols))
        window.localStorage.setItem(TABLE_HIDE_TOTAL_KEY, next.hideTotal ? '1' : '0')
        window.localStorage.setItem(TABLE_VIEW_KEY, next.view)
      } catch {
        // Not persisted, but the change still applies for this session.
      }
      return next
    })
  }

  return [prefs, update]
}

/**
 * The floor, before a waiter starts a sale.
 *
 * ── WHY THIS IS IN FRONT OF THE TILL AND NOT BESIDE IT ────────────────────
 *
 * In a restaurant the first question is always "which table", and the answer decides
 * which basket is on screen. A rail beside the basket would mean a waiter could ring up
 * three items and only then discover they were on the wrong table — and moving a line
 * between baskets is a feature this does not have.
 *
 * ── WHAT THIS LISTS: OPEN TABS, NOT CONFIGURED FURNITURE ──────────────────
 *
 * Every tile here is a BILL somebody is running — a `sales_documents` row parked
 * with a label a waiter typed. It is deliberately not a list of the shop's
 * configured tables: a floor showing forty "free" tiles buries the eight that
 * actually need attention, and the answer to "which table" on a busy night is
 * almost always one that is already open.
 *
 * Seating a *new* table is therefore an explicit act — the "Open new table" key —
 * rather than something a waiter finds by hunting for a grey tile. Shops that
 * have drawn a floor plan still get one: the Floor view renders the real room,
 * where tapping an empty table is exactly how you seat it.
 *
 * ── THE TWO HEROES ────────────────────────────────────────────────────────
 *
 * A restaurant still sells coffee over the counter, and a takeaway is most of the
 * trade in some places. Making that pass through a table is the difference between
 * a fast till and one that fights its user. So Quick sale and Open new table are
 * two large keys, first, in a fixed position — never scrolled away.
 */
export function TableGate({
  tabs,
  tables = [],
  rooms = [],
  features = [],
  visitTypes = [],
  busy,
  onWalkIn,
  onNewTable,
  onRefresh,
  splitting = false,
  onToggleSplitting,
  onSplitTable,
  onPickTab,
  onPickTable,
}: {
  /** Every bill open in the shop, newest first. */
  tabs: readonly OpenTab[]
  /** Configured tables — used by the Floor view only. */
  tables?: readonly PosTable[]
  /** Rooms with a drawn plan. Empty on a shop that never opened the designer. */
  rooms?: readonly FloorRoom[]
  features?: readonly FloorFeature[]
  /** Active types, in segment order. Empty hides the filter entirely. */
  visitTypes?: readonly VisitType[]
  busy: boolean
  /** Start a sale with no table — the counter, or a takeaway. */
  onWalkIn: () => void
  /** Name a new tab, then drop into the till on it. */
  onNewTable: () => void
  /** Re-read the floor. Another till may have opened or settled a tab. */
  onRefresh?: () => void
  /** Armed: the next FLOOR-PLAN tap opens the split screen instead of resuming. */
  splitting?: boolean
  onToggleSplitting?: (next: boolean) => void
  /** Opens the split screen for a seated table. Floor view only — see the button. */
  onSplitTable?: (table: PosTable) => void
  /** Resume an open tab. */
  onPickTab: (tab: OpenTab) => void
  /** Seat or resume a table from the drawn floor plan. */
  onPickTable: (table: PosTable) => void
}) {
  /* ── Finding a table ──────────────────────────────────────────────────────
     A busy floor holds more tables than fit on a screen, so a waiter needs to
     reach theirs fast: type a number or an area, and/or narrow to one kind of
     service. The two COMPOSE — each segment counts what the search has already
     matched, so a count of zero means "none of these match what you typed"
     rather than "none exist". */
  const [query, setQuery] = useState('')
  const [visit, setVisit] = useState<string>(ALL_VISITS)
  /* Floor or list, how many across, and whether the running total shows — all
     remembered per device. A big screen at the pass wants the plan and seven
     tables across; a small one at the bar wants the list and three, and the
     choice is a property of the till rather than of the shop. */
  const [prefs, setPrefs] = useTablePrefs()
  const { cols, hideTotal } = prefs
  const showTotals = !hideTotal

  /* More tables across → each one is narrower, so it gets shorter and its text
     steps down with it; the cards stay in proportion instead of turning into
     tall thin slivers at 7-across. Dropping the total takes a whole block off
     the bottom of the card, so the tile shrinks by that much again. */
  const tileMinH = `${
    TILE_MAX_H - (cols - COLUMN_CHOICES[0]) * TILE_H_STEP - (hideTotal ? TILE_TOTAL_H : 0)
  }px`
  const dense = cols >= DENSE_FROM_COLS

  const defaultVisitId = visitTypes.find((v) => v.isDefault)?.id ?? null

  /* A waiter looks for their table by number, for a guest by name, and for their
     own tables by their own name — so all three are searched together rather
     than behind a "search by" selector nobody would find mid-service. */
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tabs
    return tabs.filter((t) =>
      [t.label, t.customerName, t.userName, t.visitTypeName].some((v) =>
        (v ?? '').toLowerCase().includes(q),
      ),
    )
  }, [tabs, query])

  /* A tab with no visit type answers to the DEFAULT one. Nothing back-fills the
     column, and a quick sale never picks one — so filing them under "none" would
     hide most of the floor in a segment that does not exist. */
  const matchesVisit = (t: OpenTab, key: string) =>
    key === ALL_VISITS || (t.visitTypeId ?? defaultVisitId) === Number(key)

  const shown = useMemo(
    () => searched.filter((t) => matchesVisit(t, visit)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searched, visit, defaultVisitId],
  )

  const visitOptions = [
    { value: ALL_VISITS, label: 'All tables', count: searched.length },
    ...visitTypes.map((v) => ({
      value: String(v.id),
      label: v.name,
      count: searched.filter((t) => matchesVisit(t, String(v.id))).length,
    })),
  ]

  /* Counted over EVERY tab, not the filtered view: "how much is in progress in
     this shop" is a fact about the shop, and a number that moved as somebody
     typed in the search box would answer a different question each keystroke. */
  const open = tabs.length

  const hasPlan = rooms.some((room) =>
    tables.some((t) => t.roomId === room.id && t.x !== null),
  )
  /* A toggle that leads to an empty room is a dead end, so a shop that never drew a
     plan is held on the list and never learns this button could be here. */
  const effectiveView = hasPlan ? prefs.view : 'list'

  return (
    <div className="till-pane flex flex-1 flex-col overflow-y-auto p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
        {/* ── Who this screen is and what it does ─────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand">
              <Icons.LayoutGrid size={22} />
            </span>
            <div>
              <h2 className="text-[22px] font-bold leading-tight text-ink">Tables</h2>
              <p className="mt-0.5 text-[13px] text-muted">
                Resume a table in progress, open a new one, or ring up a walk-in with a
                quick sale.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {hasPlan && (
              <SegmentedControl
                aria-label="How to show the floor"
                options={[
                  { value: 'floor', label: 'Floor' },
                  { value: 'list', label: 'List' },
                ]}
                value={effectiveView}
                onChange={(next) => setPrefs({ view: next as 'floor' | 'list' })}
              />
            )}

            {/* What this DEVICE shows, not what the shop is. A screen at the pass and
                one at the bar want different amounts on a tile, and neither should be
                deciding it for the other. */}
            <Menu
              align="right"
              variant="secondary"
              label={
                <>
                  <Icons.SlidersHorizontal size={18} />
                  Customize
                </>
              }
            >
              {/* Not MenuItems: these are settings to leave open and adjust, not
                  commands that dismiss the menu the moment they are touched. */}
              <div className="flex w-[280px] flex-col gap-4 p-5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-semibold text-ink">Columns</span>
                  <Select
                    value={String(cols)}
                    onChange={(e) => setPrefs({ cols: Number(e.target.value) })}
                    aria-label="Tables per row"
                  >
                    {COLUMN_CHOICES.map((n) => (
                      <option key={n} value={String(n)}>
                        {n} across
                      </option>
                    ))}
                  </Select>
                </label>
                <Switch
                  checked={hideTotal}
                  label="Hide total"
                  hint="Smaller tiles — no running total on the table."
                  onChange={(next) => setPrefs({ hideTotal: next })}
                />
              </div>
            </Menu>

            {onRefresh && (
              <Button variant="secondary" size="touch" disabled={busy} onClick={onRefresh}>
                <Icons.Refresh size={18} />
                Refresh
              </Button>
            )}
          </div>
        </div>

        {/* ── Finding one ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 px-6 pb-4">
          <ToolbarSearch
            value={query}
            onChange={setQuery}
            placeholder="Search by table number, customer or waiter…"
            aria-label="Search open tables"
            className="w-[360px] max-w-[45%]"
          />
          {/* Only where the shop HAS types. One segment reading "All tables" is a
              control that can never change anything. */}
          {visitTypes.length > 0 && (
            <SegmentedControl
              aria-label="Filter by visit type"
              options={visitOptions}
              value={visit}
              onChange={setVisit}
            />
          )}
          <span className="ml-auto flex items-center gap-2">
            <Badge tone="brand">
              {open} open table{open === 1 ? '' : 's'}
            </Badge>
          </span>
        </div>

        {/*
          ── SPLITTING IS A MODE, NOT A CONTROL ON EACH TILE ────────────────
          A tile already carries a code, a state and a total; a second button on it
          would be a small target next to the tap that resumes the table, and getting
          that wrong opens the wrong bill in front of a customer.

          So: arm the mode, then tap the table to split. The floor stays the thing you
          tap, and the armed state says plainly what the next tap will do — which is
          also how the gesture cancels, by disarming rather than by finding a way out
          of a dialog.

          ── ONLY ON THE FLOOR VIEW ─────────────────────────────────────────
          A split MOVES lines from one table onto another, and `splitTableAction`
          identifies both by `pos_tables.id`. A free-text tab has no such id — it
          is a bill with a name on it — so there is nothing for the lines to land
          on. Offering the mode over the tab list would arm a gesture that could
          only ever fail on the second tap, in front of a customer.
        */}
        {onSplitTable && effectiveView === 'floor' && (
          <div className="px-6 pb-3">
            <Button
              variant={splitting ? 'warning' : 'ghost'}
              size="touch"
              disabled={busy}
              onClick={() => onToggleSplitting?.(!splitting)}
            >
              {/* ArrowLeftRight, not scissors: a split MOVES lines between two bills
                  rather than cutting one, and the arrow says which. */}
              <Icons.ArrowLeftRight size={18} />
              {splitting ? 'Tap the bill to split — or tap here to stop' : 'Split a bill'}
            </Button>
          </div>
        )}

        <div className="till-pane min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {effectiveView === 'floor' ? (
            <div className="flex flex-col gap-4">
              {/* Both openers stay ABOVE the plan: a walk-in and a new tab are wanted
                  just as often on the floor view, and hiding them behind the List
                  toggle would be a trap. */}
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" size="touch" disabled={busy} onClick={onWalkIn}>
                  <Icons.Zap size={18} />
                  Quick sale
                </Button>
                <Button variant="secondary" size="touch" disabled={busy} onClick={onNewTable}>
                  <Icons.Plus size={18} />
                  Open new table
                </Button>
              </div>
              {/* The plan draws the shop's CONFIGURED tables — the furniture — not
                  the tabs listed above. Occupancy comes from matching a tab's label
                  to a table's code, which `tables` already carries via its own
                  document pointer. */}
              {rooms.map((room) => {
                const placed = tables.filter((t) => t.roomId === room.id && t.x !== null)
                if (placed.length === 0) return null
                return (
                  <div key={room.id} className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {room.name}
                    </h3>
                    <FloorView
                      room={room}
                      tables={placed}
                      features={features.filter((f) => f.roomId === room.id)}
                      busy={busy}
                      splitting={splitting}
                      onPick={onPickTable}
                      onSplit={onSplitTable}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            /* ONE grid, at the column count this device chose — not auto-fill.
               The count IS the preference being set, so the track list is
               explicit and the tiles stretch to fill the row. */
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {/* The two openers first, always, in a fixed position. A restaurant
                  still sells coffee over the counter, and making that pass through a
                  table is the difference between a fast till and one that fights its
                  user — so neither of these ever scrolls away behind the tabs. */}
              <HeroTile
                tone="success"
                icon={<Icons.Zap size={dense ? 20 : 24} />}
                label="Quick sale"
                minHeight={tileMinH}
                dense={dense}
                disabled={busy}
                onClick={onWalkIn}
              />
              <HeroTile
                tone="brand"
                icon={<Icons.Plus size={dense ? 20 : 24} />}
                label="Open new table"
                minHeight={tileMinH}
                dense={dense}
                disabled={busy}
                onClick={onNewTable}
              />

              {tabs.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={<Icons.LayoutGrid size={26} />}
                    title="Nothing open yet"
                    hint="Open a new table to start a tab, or ring up a walk-in with a quick sale."
                  />
                </div>
              ) : shown.length === 0 ? (
                /* Tabs DO exist — the search or the filter hid them all, which is a
                   different problem from an empty floor and needs a different sentence. */
                <div className="col-span-full">
                  <EmptyState
                    icon={<Icons.Search size={26} />}
                    title="No open table matches that"
                    hint="Try a different search, or switch back to All tables."
                  />
                </div>
              ) : (
                shown.map((tab) => (
                  <TabCard
                    key={tab.documentId}
                    tab={tab}
                    busy={busy}
                    showTotal={showTotals}
                    dense={dense}
                    minHeight={tileMinH}
                    onPick={() => onPickTab(tab)}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── The plan ─────────────────────────────────────────────────────────────── */

/**
 * One room, drawn to scale.
 *
 * READ-ONLY. Nothing here drags: a waiter mid-service must not be able to rearrange the
 * furniture by fumbling a tap, and the designer is a back-office screen behind
 * `setup.edit` for exactly that reason. So this is plain absolute positioning with no
 * dnd-kit at all — the same percentages the designer renders, without the sensors.
 *
 * The tables wear the SAME `TILE` skins as the grid below, so a shop that has placed
 * half its floor sees one visual language rather than two. Free, open and waiting-to-pay
 * mean the same colour whichever way they are drawn.
 */
function FloorView({
  room,
  tables,
  features,
  busy,
  splitting,
  onPick,
  onSplit,
}: {
  room: FloorRoom
  tables: readonly PosTable[]
  features: readonly FloorFeature[]
  busy: boolean
  splitting: boolean
  onPick: (table: PosTable) => void
  onSplit?: (table: PosTable) => void
}) {
  return (
    <div
      className="relative overflow-hidden rounded-card border border-border bg-surface-2"
      /*
       * The room's own aspect ratio, so a long verandah is long — letterboxed rather than
       * distorted, because a plan whose proportions are wrong looks authoritative and is
       * misleading in a way a list cannot be.
       *
       * CAPPED IN HEIGHT, and that cap is the point. The first version was `w-full` with
       * only an aspect ratio, so a 100×70 room filled the page width and stood ~1100px
       * tall: one table visible and the rest below the fold. A waiter scrolling a floor
       * plan has lost the only thing a plan is for — seeing the whole room at once — so the
       * height is bounded and the width follows from it. `max-w-full` keeps a very wide
       * room inside the pane instead of the other way round.
       */
      style={{
        aspectRatio: `${room.width} / ${room.height}`,
        /* HEIGHT drives it, width follows from the ratio — an aspect ratio with only a
           maxHeight has nothing to compute from and collapses. 58vh leaves the walk-in
           button, the split control and a section heading on screen above it. */
        height: '58vh',
        maxWidth: '100%',
      }}
    >
      {features.map((f) => (
        <div
          key={f.id}
          aria-hidden
          className={`absolute flex items-center justify-center text-[10px] text-muted ${
            FEATURE_SKIN[f.kind]
          }`}
          style={{
            left: `${(f.x / room.width) * 100}%`,
            top: `${(f.y / room.height) * 100}%`,
            width: `${(f.width / room.width) * 100}%`,
            height: `${(f.height / room.height) * 100}%`,
            transform: `rotate(${f.rotation}deg)`,
          }}
        >
          {f.label}
        </div>
      ))}

      {tables.map((table) => (
        <button
          key={table.id}
          type="button"
          data-kit-ok
          data-table-code={table.code}
          disabled={busy}
          onClick={() =>
            splitting
              ? table.documentId !== null && table.state !== 'free'
                ? onSplit?.(table)
                : undefined
              : onPick(table)
          }
          className={`absolute flex flex-col items-center justify-center border-2 text-center transition active:scale-[0.97] ${
            table.shape === 'round' ? 'rounded-full' : 'rounded-card'
          } ${TILE[table.state]}`}
          style={{
            left: `${((table.x ?? 0) / room.width) * 100}%`,
            top: `${((table.y ?? 0) / room.height) * 100}%`,
            width: `${(table.width / room.width) * 100}%`,
            height: `${(table.height / room.height) * 100}%`,
            /* The BOX rotates but the label does not — a table turned 90° on a diagonal
               wall should still have a code you can read without tilting your head. */
            transform: `rotate(${table.rotation}deg)`,
          }}
        >
          <span
            className="flex flex-col items-center leading-none"
            style={{ transform: `rotate(${-table.rotation}deg)` }}
          >
            <span className="text-sm font-bold">{table.code}</span>
            {table.state !== 'free' && (
              <span className="mt-0.5 text-[10px]">{formatMoney(table.totalIncl)}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

/** How each fixed feature draws. Tokens only, same rule as TILE below. */
const FEATURE_SKIN: Record<FloorFeature['kind'], string> = {
  wall: 'bg-ink-2/60',
  bar: 'bg-warning-soft border border-warning/50',
  pass: 'bg-success-soft border border-success/50',
  door: 'border-2 border-dashed border-border-strong',
  plant: 'bg-success-soft rounded-full',
  text: '',
}

/** Per-state surface for the FLOOR plan. Tokens only — a restaurant floor on a bright
    screen still has to read, and a hex here would not follow the theme. */
const TILE: Record<TableState, string> = {
  free: 'border-border bg-surface-2 text-ink',
  open: 'border-brand/50 bg-brand-soft text-brand',
  /* The one that shouts. A table waiting to pay is the only state that needs a waiter
     to move, so it is the only one given a colour that carries urgency. */
  bill: 'border-warning/60 bg-warning-soft text-warning-ink',
}

/**
 * "Quick sale" — an opener, not a table.
 *
 * Dashed rather than solid, and the same size as a table card: it belongs to the grid
 * (so it keeps its place as the floor fills up) while never being mistaken for
 * somebody's bill. A solid card here would be a table that cannot be paid.
 */
function HeroTile({
  tone,
  icon,
  label,
  dense,
  minHeight,
  disabled,
  onClick,
}: {
  tone: 'success' | 'brand'
  icon: ReactNode
  label: string
  /** At 7 across the roomy type stops fitting — step the icon and label down. */
  dense: boolean
  /** Matches the table cards beside it, so the row is flush. */
  minHeight: string
  disabled: boolean
  onClick: () => void
}) {
  const skin =
    tone === 'success'
      ? 'border-success/40 hover:border-success hover:bg-success-soft text-success'
      : 'border-brand/40 hover:border-brand hover:bg-brand-soft text-brand'
  const disc = tone === 'success' ? 'bg-success-soft' : 'bg-brand-soft'

  return (
    <button
      type="button"
      data-kit-ok
      disabled={disabled}
      onClick={onClick}
      style={{ minHeight }}
      className={`flex flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed bg-surface ${
        dense ? 'p-3.5' : 'p-5'
      } text-center transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${skin}`}
    >
      <span
        className={`flex ${
          dense ? 'h-10 w-10' : 'h-12 w-12'
        } items-center justify-center rounded-pill ${disc}`}
      >
        {icon}
      </span>
      <span className={`${dense ? 'text-[14px]' : 'text-[16px]'} font-bold`}>{label}</span>
    </button>
  )
}

/**
 * One open tab, as a card.
 *
 * Carries the four facts a waiter actually asks for — which table, whose it is, how
 * much is on it, and how long it has been running — in a shape that has room for
 * them, at the price of fewer tabs per screen. "Hide total" buys that back on a till
 * that would rather see more of the floor.
 */
function TabCard({
  tab,
  busy,
  showTotal,
  dense,
  minHeight,
  onPick,
}: {
  tab: OpenTab
  busy: boolean
  showTotal: boolean
  /** At 7 across the roomy type stops fitting — step every size down one. */
  dense: boolean
  /** Set by the column count, so the whole row is the same height. */
  minHeight: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-kit-ok
      data-tab-label={tab.label}
      disabled={busy}
      onClick={onPick}
      style={{ minHeight }}
      className={`group flex flex-col rounded-card border border-border bg-surface ${
        dense ? 'p-3.5' : 'p-5'
      } text-left shadow-card transition hover:border-brand/50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50`}
    >
      {/* Header: the label, and its status pill. The pill sits BESIDE the label
          while there is room and WRAPS BELOW it when there isn't (flex-wrap plus
          a minimum width on the label block) — at 7 across the two cannot share a
          line, and it is the number the waiter came to read, so the number keeps
          the line and the pill takes the next one. */}
      <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <span className="flex min-w-[6.5rem] flex-1 items-center gap-2.5">
          <span
            className={`flex ${
              dense ? 'h-8 w-8' : 'h-9 w-9'
            } shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand`}
          >
            <Icons.LayoutGrid size={dense ? 16 : 18} />
          </span>
          <b
            className={`min-w-0 flex-1 truncate ${
              dense ? 'text-[16px]' : 'text-[19px]'
            } font-bold text-ink`}
          >
            {tab.label}
          </b>
        </span>

        <Badge tone="success">In progress</Badge>
      </span>

      {/* Who the tab is for. A waiter looks for the guest as often as for the
          number, so it gets its own line — right under the label, in the
          customer's own words. Omitted when the customer IS the label. */}
      {tab.customerName && (
        <span
          className={`${
            dense ? 'mt-1.5 text-[12px]' : 'mt-2 text-[13.5px]'
          } truncate font-medium text-ink`}
        >
          {tab.customerName}
        </span>
      )}

      <span
        className={`${dense ? 'mt-2 text-[11.5px]' : 'mt-3 text-[13px]'} truncate text-muted`}
      >
        {[
          `${tab.lineCount} item${tab.lineCount === 1 ? '' : 's'}`,
          sinceLabel(tab.updatedAt),
          tab.personCount ? `${tab.personCount} pax` : '',
          tab.visitTypeName ?? '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>

      {showTotal && (
        <>
          {/* The rule fences the total off from the detail above. */}
          <span className={`${dense ? 'my-2' : 'my-3'} h-px w-full bg-border`} aria-hidden />
          <span className="mt-auto flex items-end justify-between gap-2">
            <span className="flex min-w-0 flex-col">
              <span className="text-[12px] text-muted">Total</span>
              <span
                className={`numeric truncate ${
                  dense ? 'text-[17px]' : 'text-[22px]'
                } font-bold text-ink`}
              >
                {formatMoney(tab.totalIncl)}
              </span>
            </span>
            <span
              className={`flex ${
                dense ? 'h-8 w-8' : 'h-9 w-9'
              } shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink transition group-hover:bg-brand group-hover:text-white`}
            >
              <Icons.ChevronRight size={dense ? 15 : 16} />
            </span>
          </span>
        </>
      )}
    </button>
  )
}

/**
 * "12m", "1h 20m" — how long the tab has been running.
 *
 * Relative and short because it is read at a glance on a tile, and because the exact
 * time they sat down is not a thing a waiter needs. Coarse past an hour: the difference
 * between 71 and 74 minutes changes nothing, and the shorter string keeps the tile from
 * wrapping.
 */
function sinceLabel(at: Date | string): string {
  const then = typeof at === 'string' ? Date.parse(at) : at.getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000))
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  Icons,
  Menu,
  SegmentedControl,
  Switch,
  TileGrid,
  ToolbarSearch,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PosTable, TableState } from '@/lib/site/posTables'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { VisitType } from '@/lib/site/visitTypes'

/** The "no filter" segment. A string because every other segment key is one. */
const ALL_VISITS = 'ALL'

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
 * ── THE WALK-IN HERO ──────────────────────────────────────────────────────
 *
 * A restaurant still sells coffee over the counter, and a takeaway is most of the
 * trade in some places. Making that pass through a table — or worse, through a "no
 * table" tile lost among forty — is the difference between a fast till and one that
 * fights its user. So it is one large key, first, in a fixed position.
 *
 * ── THREE STATES, THREE MEANINGS ──────────────────────────────────────────
 *
 *   free  — seat someone
 *   open  — they are eating; tap to add to their bill
 *   bill  — they have asked to pay; a waiter is NEEDED
 *
 * `bill` is the only one that is coloured for attention, because on a busy floor the
 * screen's job is to answer "who needs me next". Colouring all three would answer
 * nothing — see odyssey-craft on colour that has stopped meaning anything.
 */
export function TableGate({
  tables,
  rooms = [],
  features = [],
  visitTypes = [],
  busy,
  onWalkIn,
  onRefresh,
  splitting = false,
  onToggleSplitting,
  onSplitTable,
  onPickTable,
}: {
  tables: readonly PosTable[]
  /** Rooms with a drawn plan. Empty on a shop that never opened the designer. */
  rooms?: readonly FloorRoom[]
  features?: readonly FloorFeature[]
  /** Active types, in segment order. Empty hides the filter entirely. */
  visitTypes?: readonly VisitType[]
  busy: boolean
  /** Start a sale with no table — the counter, or a takeaway. */
  onWalkIn: () => void
  /** Re-read the floor. Another till may have opened or settled a table. */
  onRefresh?: () => void
  /** Armed: the next table tap opens the split screen instead of resuming. */
  splitting?: boolean
  onToggleSplitting?: (next: boolean) => void
  /** Opens the split screen for a table that has a bill. */
  onSplitTable?: (table: PosTable) => void
  /** Seat a free table, or resume an open one. The shell decides which by state. */
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
  /* Floor or list, remembered per device. A big screen at the pass wants the
     plan; a small one at the bar wants the list, and the choice is a property of
     the till rather than of the shop. */
  const [view, setView] = useState<'floor' | 'list'>('list')
  const [showTotals, setShowTotals] = useState(true)

  const defaultVisitId = visitTypes.find((v) => v.isDefault)?.id ?? null

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tables
    return tables.filter((t) =>
      [t.code, t.name, t.section, t.visitTypeName].some((v) =>
        (v ?? '').toLowerCase().includes(q),
      ),
    )
  }, [tables, query])

  /* An unlabelled table answers to the DEFAULT type. Most tables carry no type at
     all — nothing back-filled the column and nobody labels a table they are about
     to seat — so filing them under "none" would put the whole floor in a segment
     that does not exist. */
  const matchesVisit = (t: PosTable, key: string) =>
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
  /*
   * Grouped by section, preserving the order the server sorted them in. A Map keeps
   * insertion order, so "Patio" stays where the floor put it rather than sorting
   * alphabetically — a waiter finds a section by position.
   *
   * UNPLACED tables only, once a plan exists. A table drawn on the canvas AND listed in
   * the grid below it would appear twice on one screen, and a waiter tapping the wrong
   * copy of the same table is a bug that looks like a duplicate table.
   */
  const sections = useMemo(() => {
    const bySection = new Map<string, PosTable[]>()
    for (const table of shown) {
      if (table.roomId !== null && table.x !== null) continue
      const key = table.section || ''
      const list = bySection.get(key)
      if (list) list.push(table)
      else bySection.set(key, [table])
    }
    return [...bySection.entries()]
  }, [shown])

  const waiting = tables.filter((t) => t.state === 'bill').length
  /* Counted over EVERY table, not the filtered view: "how much is in progress on this
     floor" is a fact about the shop, and a number that moved as somebody typed in the
     search box would be answering a different question each keystroke. */
  const open = tables.filter((t) => t.state !== 'free').length

  const hasPlan = rooms.some((room) =>
    tables.some((t) => t.roomId === room.id && t.x !== null),
  )
  /* A toggle that leads to an empty room is a dead end, so a shop that never drew a
     plan is held on the list and never learns this button could be here. */
  const effectiveView = hasPlan ? view : 'list'

  return (
    <div className="till-pane flex flex-1 flex-col overflow-y-auto p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
        {/* ── Who this screen is and what it does ─────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-brand-soft text-brand">
              <Icons.LayoutGrid size={22} />
            </span>
            <div>
              <h2 className="text-xl font-bold leading-tight text-ink">Tables</h2>
              <p className="mt-0.5 text-[13px] text-muted">
                Resume a table in progress, open a new one, or ring up a walk-in with a
                quick sale.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {hasPlan && (
              <SegmentedControl
                aria-label="How to show the floor"
                options={[
                  { value: 'floor', label: 'Floor' },
                  { value: 'list', label: 'List' },
                ]}
                value={effectiveView}
                onChange={(next) => setView(next as 'floor' | 'list')}
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
              {/* Not a MenuItem: this is a setting to leave open and toggle, not a
                  command that dismisses the menu the moment it is touched. */}
              <div className="w-[260px] p-4">
                <Switch
                  checked={showTotals}
                  label="Show the running total"
                  hint="Off makes each table smaller, so more of the floor fits on screen."
                  onChange={setShowTotals}
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
        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <ToolbarSearch
            value={query}
            onChange={setQuery}
            placeholder="Search by table, area or type..."
            aria-label="Search the floor"
            className="w-[320px] max-w-full"
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
            {/* The one number worth putting above the floor: who is waiting to pay.
                A waiter arriving at the screen wants that before the layout. */}
            {waiting > 0 && (
              <Badge tone="warning">
                {waiting} waiting for the bill
              </Badge>
            )}
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

          Only offered when some table HAS a bill. On an empty floor it is a button
          that can only ever explain why it does nothing.
        */}
        {onSplitTable && tables.some((t) => t.documentId !== null && t.state !== 'free') && (
          <div className="px-5 pb-3">
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

        <div className="till-pane min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {effectiveView === 'floor' ? (
            <div className="flex flex-col gap-4">
              {/* The two openers stay ABOVE the plan: a walk-in and a new table are
                  wanted just as often on the floor view, and hiding them behind the
                  List toggle would be a trap. */}
              <div className="flex flex-wrap gap-3">
                <Button variant="success" size="touch" disabled={busy} onClick={onWalkIn}>
                  <Icons.Zap size={18} />
                  Quick sale
                </Button>
              </div>
              {rooms.map((room) => {
                const placed = shown.filter((t) => t.roomId === room.id && t.x !== null)
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
            <div className="flex flex-col gap-4">
              <TileGrid tileWidth={200} tileHeight={showTotals ? 150 : 108}>
                {/* Quick sale first, always, in a fixed position: a restaurant still
                    sells coffee over the counter, and making that pass through a table
                    is the difference between a fast till and one that fights its user. */}
                <HeroTile
                  tone="success"
                  icon={<Icons.Zap size={22} />}
                  label="Quick sale"
                  hint="Ring up a walk-in"
                  disabled={busy}
                  onClick={onWalkIn}
                />
              </TileGrid>

              {tables.length === 0 ? (
                <EmptyState
                  icon={<Icons.LayoutGrid size={26} />}
                  title="No tables set up"
                  hint="A manager can add the floor in Setup → Tables. Walk-in sales work either way."
                />
              ) : shown.length === 0 ? (
                /* Tables DO exist — the search or the filter hid them all, which is a
                   different problem from an empty floor and needs a different sentence. */
                <EmptyState
                  icon={<Icons.Search size={26} />}
                  title="No table matches that"
                  hint="Try a different search, or switch back to All tables."
                />
              ) : (
                sections.map(([section, list]) => (
                  <div key={section || '_'} className="flex flex-col gap-2">
                    {/* Only when there ARE sections. A single unnamed heading over the
                        whole floor is a line that says nothing. */}
                    {section && (
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                        {section}
                      </h3>
                    )}
                    <TileGrid tileWidth={200} tileHeight={showTotals ? 150 : 108}>
                      {list.map((table) => (
                        <TableCard
                          key={table.id}
                          table={table}
                          busy={busy}
                          showTotal={showTotals}
                          /* While the split mode is armed, a tap opens the SPLIT screen
                             for that table rather than resuming it — and a free table
                             stays inert, because there is nothing on it to divide. */
                          onPick={() =>
                            splitting
                              ? table.documentId !== null && table.state !== 'free'
                                ? onSplitTable?.(table)
                                : undefined
                              : onPickTable(table)
                          }
                        />
                      ))}
                    </TileGrid>
                  </div>
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

/**
 * Per-state CARD surface, for the list.
 *
 * Only the bill-asked state is tinted. A free table and a table being eaten at are
 * both "nothing to do here yet", and colouring all three would answer nothing — see
 * odyssey-craft on colour that has stopped meaning anything. The one that needs a
 * waiter to move is the one that gets a colour.
 */
const CARD: Record<TableState, string> = {
  free: 'border-border bg-surface hover:border-brand/50',
  open: 'border-border bg-surface hover:border-brand/50',
  bill: 'border-warning/50 bg-warning-soft',
}

/** The leading disc, matching the state above. */
const DISC: Record<TableState, string> = {
  free: 'bg-surface-2 text-muted',
  open: 'bg-brand-soft text-brand',
  bill: 'bg-warning/20 text-warning-ink',
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
  hint,
  disabled,
  onClick,
}: {
  tone: 'success' | 'brand'
  icon: ReactNode
  label: string
  hint: string
  disabled: boolean
  onClick: () => void
}) {
  const skin =
    tone === 'success'
      ? 'border-success/40 hover:border-success text-success'
      : 'border-brand/40 hover:border-brand text-brand'
  const disc = tone === 'success' ? 'bg-success-soft' : 'bg-brand-soft'

  return (
    <button
      type="button"
      data-kit-ok
      disabled={disabled}
      onClick={onClick}
      className={`flex h-full flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed bg-surface px-3 text-center transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${skin}`}
    >
      <span className={`flex h-11 w-11 items-center justify-center rounded-pill ${disc}`}>
        {icon}
      </span>
      <span className="text-[15px] font-bold">{label}</span>
      <span className="text-[12px] text-muted">{hint}</span>
    </button>
  )
}

/**
 * One table, as a card.
 *
 * ── WHY A CARD AND NOT THE OLD 132px TILE ─────────────────────────────────
 *
 * The tile fitted a code and a total and nothing else, so a waiter scanning for their
 * table read a grid of numbers and had to open one to find out whose it was. The card
 * carries the same four facts a waiter actually asks for — which table, is it waiting,
 * how big is the bill, how long have they been sat — in a shape that has room for
 * them, at the price of fewer tables per screen. "Show the running total" buys that
 * back on a till that would rather see more of the floor.
 */
function TableCard({
  table,
  busy,
  showTotal,
  onPick,
}: {
  table: PosTable
  busy: boolean
  showTotal: boolean
  onPick: () => void
}) {
  const free = table.state === 'free'

  return (
    <button
      type="button"
      data-kit-ok
      disabled={busy}
      onClick={onPick}
      className={`group flex h-full flex-col rounded-card border p-3.5 text-left shadow-card transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${
        CARD[table.state]
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-card ${DISC[table.state]}`}
          >
            <Icons.LayoutGrid size={17} />
          </span>
          <b className="min-w-0 flex-1 truncate text-[17px] font-bold text-ink">
            {table.code}
          </b>
        </span>

        {/* One pill, and only where it MEANS something. A "free" badge on every empty
            table is a row of labels saying nothing; the bill-asked one is the whole
            reason a waiter is looking at this screen. */}
        {table.state === 'bill' ? (
          <Badge tone="warning">Bill asked</Badge>
        ) : !free ? (
          <Badge tone="success">In progress</Badge>
        ) : null}
      </span>

      {/* The line under the number: what the table IS when free, what is on it when
          not. Both are what a waiter reads next after the number itself. */}
      <span className="mt-2 truncate text-[12.5px] text-muted">
        {free
          ? [table.name, table.seats > 0 ? `${table.seats} seats` : '']
              .filter(Boolean)
              .join(' · ') || 'Free'
          : [
              `${table.lineCount} item${table.lineCount === 1 ? '' : 's'}`,
              table.openedAt ? sinceLabel(table.openedAt) : '',
              table.visitTypeName ?? '',
            ]
              .filter(Boolean)
              .join(' · ')}
      </span>

      {showTotal && (
        <>
          <span className="my-2.5 h-px w-full bg-border" aria-hidden />
          <span className="mt-auto flex items-end justify-between gap-2">
            <span className="flex min-w-0 flex-col">
              <span className="text-[11px] text-muted">{free ? '' : 'Total'}</span>
              <span className="numeric truncate text-lg font-bold text-ink">
                {free ? '' : formatMoney(table.totalIncl)}
              </span>
            </span>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink transition group-hover:bg-brand group-hover:text-white">
              <Icons.ChevronRight size={16} />
            </span>
          </span>
        </>
      )}
    </button>
  )
}

/**
 * "12m", "1h 20m" — how long they have been sat.
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

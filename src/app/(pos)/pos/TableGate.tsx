'use client'

import { useMemo } from 'react'
import { Badge, Button, EmptyState, Icons, TileGrid } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PosTable, TableState } from '@/lib/site/posTables'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'

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
  busy,
  onWalkIn,
  splitting = false,
  onToggleSplitting,
  onSplitTable,
  onPickTable,
}: {
  tables: readonly PosTable[]
  /** Rooms with a drawn plan. Empty on a shop that never opened the designer. */
  rooms?: readonly FloorRoom[]
  features?: readonly FloorFeature[]
  busy: boolean
  /** Start a sale with no table — the counter, or a takeaway. */
  onWalkIn: () => void
  /** Armed: the next table tap opens the split screen instead of resuming. */
  splitting?: boolean
  onToggleSplitting?: (next: boolean) => void
  /** Opens the split screen for a table that has a bill. */
  onSplitTable?: (table: PosTable) => void
  /** Seat a free table, or resume an open one. The shell decides which by state. */
  onPickTable: (table: PosTable) => void
}) {
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
    for (const table of tables) {
      if (table.roomId !== null && table.x !== null) continue
      const key = table.section || ''
      const list = bySection.get(key)
      if (list) list.push(table)
      else bySection.set(key, [table])
    }
    return [...bySection.entries()]
  }, [tables])

  const waiting = tables.filter((t) => t.state === 'bill').length

  return (
    <div className="till-pane flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* ── Walk-in ─────────────────────────────────────────────────────── */}
      <Button
        variant="primary"
        size="touch-lg"
        className="w-full justify-center text-lg"
        disabled={busy}
        onClick={onWalkIn}
      >
        <Icons.ShoppingCart size={24} />
        Walk-in or takeaway
      </Button>

      {/* The one number worth putting above the floor: who is waiting to pay. A
          waiter arriving at the screen wants that before they want the layout. */}
      {waiting > 0 && (
        <div className="flex items-center gap-2 text-sm font-medium text-warning-ink">
          <Icons.Clock size={16} />
          {waiting} table{waiting === 1 ? '' : 's'} waiting for the bill
        </div>
      )}

      {/*
        ── SPLITTING IS A MODE, NOT A CONTROL ON EACH TILE ──────────────────
        A 132px tile already carries a code, a state and a total; a second button on it
        would be a ~40px target inside a 112px one, next to the tap that resumes the
        table. Getting that wrong opens the wrong bill in front of a customer.

        So: arm the mode, then tap the table to split. The floor stays the thing you tap,
        and the armed state says plainly what the next tap will do — which is also how the
        gesture cancels, by disarming rather than by finding a way out of a dialog.

        Only offered when some table HAS a bill. On an empty floor it is a button that can
        only ever explain why it does nothing.
      */}
      {onSplitTable && tables.some((t) => t.documentId !== null && t.state !== 'free') && (
        <Button
          variant={splitting ? 'warning' : 'ghost'}
          size="touch"
          className="w-full justify-center"
          disabled={busy}
          onClick={() => onToggleSplitting?.(!splitting)}
        >
          {/* ArrowLeftRight, not scissors: a split MOVES lines between two bills rather
              than cutting one, and the arrow says which. (Scissors is also not in the
              kit — the third time this project that an icon name was assumed rather than
              checked, which is why test-icon-names exists.) */}
          <Icons.ArrowLeftRight size={20} />
          {splitting ? 'Tap the bill to split — or tap here to stop' : 'Split a bill'}
        </Button>
      )}

      {/*
        ── THE PLAN, WHEN THERE IS ONE ───────────────────────────────────────
        Rendered per room, above the sectioned grid rather than instead of it: a shop that
        has placed half its tables gets the canvas for what it built and the list for the
        rest, and nothing disappears from a waiter's screen mid-reorganisation.

        A room with no placed tables draws nothing — an empty rectangle labelled "Patio"
        tells a waiter less than not showing it at all.
      */}
      {rooms.map((room) => {
        const placed = tables.filter((t) => t.roomId === room.id && t.x !== null)
        if (placed.length === 0) return null
        return (
          <div key={room.id} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              {room.name}
            </h2>
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

      {tables.length === 0 ? (
        <EmptyState
          icon={<Icons.LayoutGrid size={26} />}
          title="No tables set up"
          hint="A manager can add the floor in Setup → Tables. Walk-in sales work either way."
        />
      ) : (
        sections.map(([section, list]) => (
          <div key={section || '_'} className="flex flex-col gap-2">
            {/* Only when there ARE sections. A single unnamed heading over the whole
                floor is a line that says nothing. */}
            {section && (
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                {section}
              </h2>
            )}
            <TileGrid tileWidth={132} tileHeight={112}>
              {list.map((table) => (
                <TableTile
                  key={table.id}
                  table={table}
                  busy={busy}
                  /* While the split mode is armed, a tap opens the SPLIT screen for that
                     table rather than resuming it — and a free table stays inert, because
                     there is nothing on it to divide. */
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

/** Per-state surface. Tokens only — a restaurant floor on a bright screen still has
    to read, and a hex here would not follow the theme. */
const TILE: Record<TableState, string> = {
  free: 'border-border bg-surface-2 text-ink',
  open: 'border-brand/50 bg-brand-soft text-brand',
  /* The one that shouts. A table waiting to pay is the only state that needs a waiter
     to move, so it is the only one given a colour that carries urgency. */
  bill: 'border-warning/60 bg-warning-soft text-warning-ink',
}

function TableTile({
  table,
  busy,
  onPick,
}: {
  table: PosTable
  busy: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      data-kit-ok
      disabled={busy}
      onClick={onPick}
      className={`flex h-full flex-col items-center justify-center gap-1 rounded-card border-2 px-2 text-center transition active:scale-[0.97] ${
        TILE[table.state]
      }`}
    >
      <span className="text-xl font-bold leading-none">{table.code}</span>

      {/* Seats, only when somebody has said. Zero means unset, not a table for
          nobody — showing "0 seats" would be worse than showing nothing. */}
      {table.state === 'free' && table.seats > 0 && (
        <span className="text-[11px] text-muted">{table.seats} seats</span>
      )}

      {/* On an occupied table the MONEY is what a waiter is looking for, and the line
          count is how they recognise which bill it is. */}
      {table.state !== 'free' && (
        <>
          <span className="numeric text-sm font-bold">{formatMoney(table.totalIncl)}</span>
          <span className="text-[11px] opacity-80">
            {table.lineCount} item{table.lineCount === 1 ? '' : 's'}
            {table.openedAt ? ` · ${sinceLabel(table.openedAt)}` : ''}
          </span>
        </>
      )}

      {table.state === 'bill' && (
        <Badge tone="warning" className="mt-0.5">
          Bill asked
        </Badge>
      )}

      {table.name && table.state === 'free' && (
        <span className="line-clamp-1 text-[10px] text-faint">{table.name}</span>
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

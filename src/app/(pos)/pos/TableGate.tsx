'use client'

import { useMemo } from 'react'
import { Badge, Button, EmptyState, Icons, TileGrid } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PosTable, TableState } from '@/lib/site/posTables'

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
  busy,
  onWalkIn,
  splitting = false,
  onToggleSplitting,
  onSplitTable,
  onPickTable,
}: {
  tables: readonly PosTable[]
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
  /* Grouped by section, preserving the order the server sorted them in. A Map keeps
     insertion order, so "Patio" stays where the floor put it rather than sorting
     alphabetically — a waiter finds a section by position. */
  const sections = useMemo(() => {
    const bySection = new Map<string, PosTable[]>()
    for (const table of tables) {
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

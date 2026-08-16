'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  CategoryTile,
  EmptyState,
  Icons,
  Menu,
  FeatureGlyph,
  SegmentedControl,
  Select,
  Switch,
  TableGlyph,
  ToolbarSearch,
  toneForId,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { seatLayout } from '@/lib/site/floorGeometry'
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
  transferring = false,
  onToggleTransferring,
  onTransferTable,
  onEmptyArm,
  onShowQuickKeys,
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
  /**
   * Armed: the next tap on a table-backed bill opens the split screen instead of
   * resuming it. Armed by the `split-table` QUICK KEY — this screen no longer
   * carries a button for it, only the banner that says a mode is live.
   */
  splitting?: boolean
  onToggleSplitting?: (next: boolean) => void
  /** Opens the split screen for a seated table. Works on either view. */
  onSplitTable?: (table: PosTable) => void
  /** Armed: the next tap picks the tab to MOVE instead of resuming it. */
  transferring?: boolean
  onToggleTransferring?: (next: boolean) => void
  /** Opens the destination picker for a seated table's whole tab. Either view. */
  onTransferTable?: (table: PosTable) => void
  /**
   * A mode was armed with nothing on screen it could act on, and has been dropped.
   *
   * The gate refuses silently without this: it owns no toast, and the key that armed
   * the mode was pressed on another screen entirely. The shell says why.
   */
  onEmptyArm?: (mode: 'split' | 'move') => void
  /**
   * Opens the shop's own keys for the floor — the `tables` bar from the designer.
   *
   * The gate never learns what a quick key IS: the shell owns the runner, the
   * capability checks and the dialogs each key leads to, and a floor that could run
   * one itself would be a second place deciding what a key means.
   *
   * Optional so a retail till — which has no floor and no tables bar — simply does
   * not pass one. A hospitality till always does, EMPTY BAR INCLUDED: nothing had
   * ever written to that section, so hiding the button until it was filled hid it on
   * every existing shop. The dialog teaches the empty case instead.
   */
  onShowQuickKeys?: () => void
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

  /* ── Which configured table carries each bill ─────────────────────────────
     A tab and a table meet on sales_documents.id: `PosTable.documentId` points at
     the same row `OpenTab.documentId` is. That is what lets the LIST view show
     the floor view's bill-asked state — the one state a waiter must not miss —
     without a second query. A counter basket parked into the tab list, or a tab
     on a deactivated table, simply has no match and falls back to elapsed time. */
  const tableStateByDoc = useMemo(() => {
    const map = new Map<number, TableState>()
    for (const t of tables) {
      if (t.documentId !== null) map.set(t.documentId, t.state)
    }
    return map
  }, [tables])

  /* The same join the other way round, for the armed modes.
     Split and move both act on a `pos_tables` row, so a tab can only be their source
     if a configured table is carrying it. Held as the table ITSELF rather than a
     boolean: the handlers take a PosTable, and re-finding it on tap would mean
     scanning `tables` a second time inside the click. */
  const tableByDoc = useMemo(() => {
    const map = new Map<number, PosTable>()
    for (const t of tables) {
      if (t.documentId !== null) map.set(t.documentId, t)
    }
    return map
  }, [tables])

  /* Armed, and this device can actually act on the tap. Both modes are exclusive and
     each has its own handler, so "armed" alone is not enough to know what a tap means. */
  const arming = (splitting && onSplitTable) || (transferring && onTransferTable) ? true : false

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

  /* How many of the bills ON SCREEN could be a source. Counted over `shown` rather
     than over every tab, because that is what the waiter can actually reach: with the
     search or the visit filter narrowing the floor to free-text tabs only, arming
     would present a screen of dead tiles and no way to tell why. */
  const armableCount = useMemo(
    () => shown.filter((t) => tableByDoc.has(t.documentId)).length,
    [shown, tableByDoc],
  )

  /* Disarm when there is nothing the mode could act on.
     Two ways in: a waiter arms it and then types in the search box, or the key arms it
     on a floor that never had a table-backed bill. Either way the banner would sit
     amber saying "tap the bill" over a screen where no tap does anything, and with the
     header buttons gone there is nothing else to explain it — so this refuses out loud
     rather than leaving a dead mode up.

     `onEmptyArm` is what carries the reason: the gate has no toast of its own, and the
     shell owns the one the key was pressed from. */
  /* Said ONCE per arming. The effect re-runs whenever `armableCount` moves — and it
     moves on its own, because the floor is re-read on a timer behind this screen — so
     without a latch the same refusal stacked up two and three toasts deep for a single
     press of the key. React's development double-invoke made it a guaranteed pair. */
  const refusedArm = useRef(false)
  useEffect(() => {
    if (!splitting && !transferring) {
      refusedArm.current = false
      return
    }
    if (armableCount === 0 && !refusedArm.current) {
      refusedArm.current = true
      onToggleSplitting?.(false)
      onToggleTransferring?.(false)
      onEmptyArm?.(splitting ? 'split' : 'move')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armableCount, splitting, transferring])

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
    /* `px-4 pb-4`, no top: TillStatusBar carries its own py-4, so the gap
       under the chips is already paid for. */
    <div className="till-pane flex flex-1 flex-col overflow-y-auto px-4 pb-4">
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
              /* Settings, not commands: the waiter sets the columns AND the total
                 in one visit, so neither control may dismiss the panel. */
              keepOpen
              label={
                <>
                  <Icons.SlidersHorizontal size={18} />
                  Customize
                </>
              }
            >
              {/* Not MenuItems: these are settings to leave open and adjust, not
                  commands that dismiss the menu the moment they are touched —
                  which is what `keepOpen` above buys. */}
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

            {/* The shop's own keys, reachable WITHOUT opening a table first.
                Everything else on this screen needs a bill to act on; these are the
                acts that do not — clocking on, a reprint, a payment against an
                account — and before this button the only way to one was to seat a
                table you did not want in order to reach the pane behind it. */}
            {onShowQuickKeys && (
              <Button variant="secondary" size="touch" disabled={busy} onClick={onShowQuickKeys}>
                <Icons.Sparkles size={18} />
                Quick keys
              </Button>
            )}

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
          ── ARMED FROM A QUICK KEY, NOT FROM A BUTTON HERE ─────────────────
          Split and Move used to be a pair of buttons on this header. They are quick
          keys now: a shop that serves tables puts them on a bar and decides where,
          and a shop that does not never pays for them in header space. See the
          `split-table` and `table-transfer` entries in quickKeyRunner.

          What stayed is everything BELOW the arming — `splitting` and `transferring`
          still come in as props, a tap on an armable bill still runs the gesture, and
          the banner below still says what the next tap will do. Only the on/off
          switch moved.

          A tile decides for itself whether it can be a target: a split moves lines
          between two `pos_tables` rows, so a bill carried by a configured table is
          armable and a free-text tab is not (see `tableByDoc` and TabCard's
          `armable`). What is refused is refused on the tile, before the tap, rather
          than on the second tap in front of a customer.
        */}
        {arming && (
          <div className="px-6 pb-3">
            {/* The armed state needs somewhere to live now that the button that used
                to carry it is gone — otherwise the mode is invisible and the only clue
                is that the tiles look different. Also the way OUT: with no button to
                tap again, this is what cancels. */}
            <div className="flex flex-wrap items-center gap-3 rounded-card border border-warning bg-warning-soft px-4 py-2.5">
              <Icons.ArrowLeftRight size={18} className="text-warning" />
              <span className="text-[14px] font-semibold text-ink">
                {splitting ? 'Tap the bill to split.' : 'Tap the bill to move.'}
              </span>
              <span className="text-[13px] text-muted">
                {armableCount === 1 ? '1 bill can' : `${armableCount} bills can`} take it.
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => {
                  onToggleSplitting?.(false)
                  onToggleTransferring?.(false)
                }}
              >
                Cancel
              </Button>
            </div>
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
                      transferring={transferring}
                      onPick={onPickTable}
                      onSplit={onSplitTable}
                      onTransfer={onTransferTable}
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
                subtitle="Counter or takeaway — no table"
                minHeight={tileMinH}
                dense={dense}
                disabled={busy}
                onClick={onWalkIn}
              />
              <HeroTile
                tone="brand"
                icon={<Icons.Plus size={dense ? 20 : 24} />}
                label="Open new table"
                subtitle="Seat guests and start a tab"
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
                shown.map((tab) => {
                  /* Which configured table carries this bill — the source the armed
                     gesture needs. Undefined for a free-text tab, which is what makes
                     the tile inert while a mode is armed. */
                  const sourceTable = tableByDoc.get(tab.documentId)
                  return (
                    <TabCard
                      key={tab.documentId}
                      tab={tab}
                      tableState={tableStateByDoc.get(tab.documentId) ?? null}
                      busy={busy}
                      showTotal={showTotals}
                      dense={dense}
                      minHeight={tileMinH}
                      /* Only meaningful while a mode is armed: it dims the tabs the
                         gesture cannot use and labels why, so the refusal lands before
                         the tap rather than as a toast after it. */
                      arming={arming}
                      armable={sourceTable !== undefined}
                      onPick={() => {
                        /* Armed taps mean the mode, not "resume". Guarded on a real
                           source table so a free-text tab cannot start a gesture that
                           the server would only refuse later. */
                        if (arming) {
                          if (!sourceTable) return
                          if (splitting) onSplitTable?.(sourceTable)
                          else if (transferring) onTransferTable?.(sourceTable)
                          return
                        }
                        onPickTab(tab)
                      }}
                    />
                  )
                })
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
  transferring,
  onPick,
  onSplit,
  onTransfer,
}: {
  room: FloorRoom
  tables: readonly PosTable[]
  features: readonly FloorFeature[]
  busy: boolean
  splitting: boolean
  transferring: boolean
  onPick: (table: PosTable) => void
  onSplit?: (table: PosTable) => void
  onTransfer?: (table: PosTable) => void
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
          /* The tone only — the SHAPE is drawn by FeatureGlyph inside, the same
             component the floor designer uses. */
          className={`absolute ${FEATURE_TONE[f.kind]}`}
          style={{
            left: `${(f.x / room.width) * 100}%`,
            top: `${(f.y / room.height) * 100}%`,
            width: `${(f.width / room.width) * 100}%`,
            height: `${(f.height / room.height) * 100}%`,
            transform: `rotate(${f.rotation}deg)`,
          }}
        >
          <FeatureGlyph kind={f.kind} className="absolute inset-0 h-full w-full" />
          {f.label && (
            <span
              className="absolute inset-0 flex items-center justify-center text-center text-[10px] font-medium leading-none"
              style={{ transform: `rotate(${-f.rotation}deg)` }}
            >
              {f.label}
            </span>
          )}
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
              : transferring
                ? table.documentId !== null && table.state !== 'free'
                  ? onTransfer?.(table)
                  : undefined
                : onPick(table)
          }
          /* No border or radius of its own: the TABLE is drawn by TableGlyph inside,
             which is what gives a round top round edges and a counter its rounded ends.
             The state token still lives here, as a text colour the glyph inherits. */
          className={`absolute transition active:scale-[0.97] ${TILE[table.state]}`}
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
          {/* The same component the designer draws with, so what a manager arranged is
              literally what a waiter sees — see the note on TableGlyph. */}
          <TableGlyph
            shape={table.shape}
            seats={seatLayout(table.seats, table.width, table.height)}
            className="absolute inset-0 h-full w-full"
          />
          <span
            className="absolute inset-0 flex flex-col items-center justify-center leading-none"
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

/**
 * What colour each fixed feature reads as. Tokens only, same rule as TILE below.
 *
 * TEXT colours: `FeatureGlyph` draws the shape and inherits this through `currentColor`,
 * so a fixture's fill, outline and label can never disagree. Same map the designer uses.
 */
const FEATURE_TONE: Record<FloorFeature['kind'], string> = {
  wall: 'text-ink-2',
  bar: 'text-warning-ink',
  pass: 'text-success',
  door: 'text-border-strong',
  plant: 'text-success',
  text: 'text-muted',
}

/**
 * Per-state colour for the FLOOR plan. Tokens only — a restaurant floor on a bright
 * screen still has to read, and a hex here would not follow the theme.
 *
 * TEXT colours, not surfaces: the tile's shape is drawn by `TableGlyph`, which fills and
 * strokes with `currentColor`. So one class here colours the table top, its outline, its
 * chairs and its code together, and a state can never end up with a brand-coloured top
 * and a neutral outline because two class lists disagreed.
 */
const TILE: Record<TableState, string> = {
  free: 'text-ink',
  open: 'text-brand',
  /* The one that shouts. A table waiting to pay is the only state that needs a waiter
     to move, so it is the only one given a colour that carries urgency. */
  bill: 'text-warning-ink',
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
  subtitle,
  dense,
  minHeight,
  disabled,
  onClick,
}: {
  tone: 'success' | 'brand'
  icon: ReactNode
  label: string
  /** One muted line saying what the key does — the difference between the two
   *  openers, taught on the tile instead of on a training day. */
  subtitle?: string
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
      <span className="flex flex-col gap-1">
        <span className={`${dense ? 'text-[14px]' : 'text-[16px]'} font-bold`}>{label}</span>
        {/* Dropped when dense — at 7 across the tile has no room for a sentence,
            and the label alone is what a practised hand needs anyway. */}
        {subtitle && !dense && (
          <span className="text-[12.5px] font-medium text-muted">{subtitle}</span>
        )}
      </span>
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
  tableState,
  busy,
  showTotal,
  dense,
  minHeight,
  arming = false,
  armable = true,
  onPick,
}: {
  tab: OpenTab
  /** The matched table's floor state, or null when no configured table holds this bill. */
  tableState: TableState | null
  busy: boolean
  showTotal: boolean
  /** At 7 across the roomy type stops fitting — step every size down one. */
  dense: boolean
  /** Set by the column count, so the whole row is the same height. */
  minHeight: string
  /** A split or move mode is armed, so a tap means the gesture rather than "resume". */
  arming?: boolean
  /** A configured table carries this bill, so it can be the gesture's source. */
  armable?: boolean
  onPick: () => void
}) {
  const billAsked = tableState === 'bill'
  /* Inert rather than hidden: a waiter hunting for table 12 mid-gesture must still
     find it on screen, and a tile that vanished when a mode armed would read as a
     bill that had been settled by somebody else. */
  const inert = arming && !armable
  const mins = minutesSince(tab.updatedAt)
  /* Untouched too long is worth a colour, but only bill-asked earns the dot: one
     is "worth a look", the other is "somebody is waiting to pay". */
  const stale = mins !== null && mins >= STALE_AFTER_MIN

  return (
    <button
      type="button"
      data-kit-ok
      data-tab-label={tab.label}
      disabled={busy || inert}
      /* Says WHY it will not take the tap, on the tile itself. A waiter who armed
         the mode and found half the floor dead needs the reason here, not in a
         toast they have to trigger first. */
      title={inert ? 'This bill is not on a configured table, so it cannot be split or moved.' : undefined}
      onClick={onPick}
      style={{ minHeight }}
      className={`group flex flex-col rounded-card border ${
        /* Armed and usable: the tile says so, in the same amber the buttons wear
           while a mode is live, so the eye goes straight to what it may tap. */
        arming && armable
          ? 'border-warning ring-2 ring-warning/40 hover:border-warning'
          : /* The same amber the floor view paints a bill-asked tile — the two views
               must say "waiting to pay" in one colour, whichever one is open. */
            billAsked
            ? 'border-warning/60 hover:border-warning'
            : 'border-border hover:border-brand/50'
      } bg-surface ${
        dense ? 'p-3.5' : 'p-5'
      } text-left shadow-card transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50`}
    >
      {/* Header: the label, and its status pill. The pill sits BESIDE the label
          while there is room and WRAPS BELOW it when there isn't (flex-wrap plus
          a minimum width on the label block) — at 7 across the two cannot share a
          line, and it is the number the waiter came to read, so the number keeps
          the line and the pill takes the next one. */}
      <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <span className="flex min-w-[6.5rem] flex-1 items-center gap-2.5">
          {/* The card's identity: its own colour and its own code, so a waiter
              finds "111" by shape on a full floor rather than by reading every
              label. Tone comes from the LABEL, not the document — the document
              is new every visit, and table 111 must stay the same colour. */}
          <CategoryTile
            tone={toneForLabel(tab.label)}
            size={dense ? 'sm' : 'md'}
            icon={<span className="text-[11px] font-bold tracking-wide">{shortLabel(tab.label)}</span>}
          />
          <b
            className={`min-w-0 flex-1 truncate ${
              dense ? 'text-[16px]' : 'text-[19px]'
            } font-bold text-ink`}
          >
            {tab.label}
          </b>
        </span>

        {/* The pill carries the one fact that VARIES. "In progress" on every card
            said nothing — every tab on this screen is in progress. */}
        {billAsked ? (
          <Badge tone="warning" dot>
            Bill asked
          </Badge>
        ) : (
          <Badge tone={stale ? 'warning' : 'neutral'}>{sinceLabel(tab.updatedAt) || 'Open'}</Badge>
        )}
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
        {/* No time here — the status pill above already carries it, and the same
            fact twice on one card is the card teaching people not to read it. */}
        {[
          `${tab.lineCount} item${tab.lineCount === 1 ? '' : 's'}`,
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

/** Untouched this long, a tab's time pill turns amber. About two drink rounds —
 *  long enough that a table nobody has rung anything up for is worth a look. */
const STALE_AFTER_MIN = 45

/** Whole minutes since `at`, or null when the date cannot be read. */
function minutesSince(at: Date | string): number | null {
  const then = typeof at === 'string' ? Date.parse(at) : at.getTime()
  if (!Number.isFinite(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 60_000))
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
  const mins = minutesSince(at)
  if (mins === null) return ''
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * What the identity disc shows: "111" stays "111", "Walk-in Bar" becomes "WB".
 *
 * A short numeric label IS the identity a waiter knows, so it survives whole;
 * anything wordier collapses to two initials the way the operator chip does.
 */
function shortLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed.length === 0) return '?'
  if (/^\d{1,4}$/.test(trimmed)) return trimmed
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const first = parts[0][0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] ?? '')
  return (first + last).toUpperCase()
}

/**
 * A stable tone per LABEL, not per document id.
 *
 * Each visit to table "111" is a new sales document, so hashing the id would
 * repaint the table every service. The label is what stays the same, so it is
 * what the colour hangs off.
 */
function toneForLabel(label: string) {
  let hash = 0
  for (const ch of label.trim().toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return toneForId(hash)
}

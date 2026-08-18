import type { LayoutItem } from 'react-grid-layout'

/**
 * The widget registry — the single source of truth for what the dashboard can
 * show, what each widget is called, and where it sits by default.
 *
 * Each KPI is its OWN widget rather than one "KPI strip" widget, so a store
 * that never looks at average items per sale can hide that one tile and give
 * the room to something it does look at.
 */

/**
 * The grid is SIXTY columns, not twelve.
 *
 * Twelve cannot be divided into fifths, and the KPI tiles have to share a row
 * evenly however many of them there are. Sixty is the smallest count that
 * divides cleanly by 2, 3, 4, 5 and 6, so a half (30), a third (20), a quarter
 * (15) and a fifth (12) are all whole numbers and every arrangement lands on
 * exact columns.
 */
export const GRID_COLS = 60

export type WidgetId =
  | 'turnoverIncl'
  | 'turnoverExcl'
  | 'grossProfit'
  | 'saleCount'
  | 'avgSaleValue'
  | 'avgItemsPerSale'
  | 'perHour'
  | 'perDay'
  | 'countPerDay'
  | 'tenderTypes'
  | 'topProducts'
  | 'topDepartments'
  | 'topCashiers'
  | 'voidsAndReturns'
  /* Job cards. All as-at-now: a job board is a picture of right now. */
  | 'jobsOpen'
  | 'jobsUnassigned'
  | 'jobsInProgress'
  | 'jobsAwaitingParts'
  | 'jobsNotInvoiced'
  | 'jobsByStatus'
  | 'jobsByTechnician'
  /* The as-at-now half — see `scope` below. */
  | 'attention'
  | 'debtorsAgeing'
  | 'creditorsAgeing'
  | 'cashPosition'
  | 'pipeline'
  | 'reorder'

/**
 * Which question a widget answers, and therefore which payload feeds it.
 *
 * `range` widgets move when the toolbar moves. `asAt` widgets do NOT — a debtor
 * ageing is true right now and cannot be "as at last March" without either an
 * expensive reconstruction or a lie. The screen marks the difference rather
 * than hiding it, because a figure that ignores the date range sitting silently
 * under one is read as belonging to it.
 */
export type WidgetScope = 'range' | 'asAt'

export type WidgetDef = {
  id: WidgetId
  title: string
  default: Pick<LayoutItem, 'x' | 'y' | 'w' | 'h' | 'minW' | 'minH'>
  /** Fixed-size widgets can be dragged but not resized. */
  resizable?: boolean
  /** Defaults to 'range', so the twelve original widgets need no entry. */
  scope?: WidgetScope
  /**
   * Hides the widget's toggle from the panel when the user cannot see its data.
   * A UI affordance ONLY — the endpoints do the real gating, and this exists so
   * a user is not offered a switch that turns on an empty box.
   */
  capability?: string
  /**
   * The module the shop must have BOUGHT for this widget to mean anything.
   *
   * Unlike `capability`, this is not merely an affordance: a job-card panel on
   * the dashboard of a shop that never bought Job Cards is an advert dressed as
   * data, and it would sit there reading zero for ever.
   */
  module?: string
}

/**
 * The KPI ids, in the order they appear — one row, so the order is the reading
 * order, left to right.
 *
 * Money first and widening: what was taken, what of it is the shop's, what was
 * made on it. Then the shape of the trade behind that money — how big a basket,
 * how full, and how many. Sales sits last rather than beside the money because
 * it is a count, not an amount, and the eye should reach the four money figures
 * without stepping over it.
 */
export const KPI_IDS = [
  'turnoverIncl',
  'turnoverExcl',
  'grossProfit',
  'avgSaleValue',
  'avgItemsPerSale',
  'saleCount',
] as const

export type KpiId = (typeof KPI_IDS)[number]

const KPI_TITLES: Record<KpiId, string> = {
  turnoverIncl: 'Turnover incl',
  turnoverExcl: 'Turnover excl',
  grossProfit: 'Gross profit',
  saleCount: 'Sales',
  avgSaleValue: 'Average sale',
  avgItemsPerSale: 'Items per sale',
}

// Six KPIs, ALL SIX to a row.
//
// The width is the whole history of this file, and it has gone back and forth.
// Six tiles at a twelfth of the grid once truncated every money figure to
// "R2 658 …", which is what pushed them to three-and-three at a third each.
//
// A sixth (10 of 60 columns, ~196px at a 1600 viewport) works NOW because the
// tile no longer clips: `valueSize()` in KpiTile steps the figure down a type
// size as it lengthens, and the Sparkline's height is a ceiling rather than a
// fixed block, so a shorter tile simply gets a shorter chart. The figures that
// used to truncate now fit.
//
// What it buys is the row underneath: at three-across the tiles ate two rows —
// 160px twice, plus a gap — before the first chart. One row of KPIs puts the
// day's trading and the first real chart on the same screen, which is what a
// dashboard is for.
const KPI_PER_ROW = 6
const KPI_W = GRID_COLS / KPI_PER_ROW
// Three rows — 160px — and the trend chart takes what is left rather than the
// tile being sized around it.
//
// Four rows (220px) gave the chart its full 76px, but six of those is 460px of
// dashboard before the first real chart, and a KPI tile is a number you glance
// at. The number, its comparison and a readable trend all fit in 160: the tile
// spends 104px on text — 16 of top padding, 32 for the header (the icon badge,
// not the label, sets that height), 30 for the figure, 16 for the comparison,
// plus the gaps — and the chart takes the ~32px that remain. It is not sized
// down by hand anywhere; the Sparkline's height is a ceiling and the block
// shrinks to fit, so a tile dragged taller gets a taller chart for free.
const KPI_H = 3

/**
 * The floor a KPI tile can be dragged to.
 *
 * A sixth of the grid is ~196px at a 1600px viewport, which is about where a
 * long money figure starts stepping down a type size to stay whole — narrower
 * than that and the tile is showing a shrunken number rather than saving space.
 * Three rows is the floor for the same reason in the other direction: the text
 * alone is 104px and the chart block cannot give up its padding, so a two-row
 * tile (100px) would simply have its bottom clipped by the card.
 */
const KPI_MIN_W = GRID_COLS / 6
const KPI_MIN_H = 3

const KPI_WIDGETS: WidgetDef[] = KPI_IDS.map((id, i) => ({
  id,
  title: KPI_TITLES[id],
  default: {
    x: (i % KPI_PER_ROW) * KPI_W,
    // Wrap onto the next row. Computed rather than hardcoded so changing
    // KPI_W again cannot silently stack every tile on top of the first.
    y: Math.floor(i / KPI_PER_ROW) * KPI_H,
    w: KPI_W,
    h: KPI_H,
    minW: KPI_MIN_W,
    minH: KPI_MIN_H,
  },
  // Resizable, like every other widget. They were fixed because the default was
  // the only size that worked: the figure truncated when narrow and the tile
  // had no chart to give up when short. Neither is true any more — the figure
  // steps down instead of clipping and the chart shrinks with the tile — so a
  // store that wants six small tiles on one row can now just drag them there.
}))

/**
 * Height of the KPI tiles themselves — now a single row of six.
 *
 * Still computed rather than written as `3`, so putting them back onto two
 * rows is a one-line change to KPI_PER_ROW and every y below follows.
 */
const KPI_ROWS_H = Math.ceil(KPI_IDS.length / KPI_PER_ROW) * KPI_H

/**
 * Where the rest of the dashboard starts.
 *
 * The tiles fill their row exactly, so nothing sits beside them and this is
 * simply the bottom of the block.
 */
const KPI_BLOCK_H = KPI_ROWS_H

/* Named fractions of the grid, so a layout reads as "half" rather than as a
   number whose meaning depends on GRID_COLS. All exact at sixty columns. */
const HALF = GRID_COLS / 2
const THIRD = GRID_COLS / 3
const TWO_THIRDS = THIRD * 2
const QUARTER = GRID_COLS / 4
const THREE_QUARTERS = QUARTER * 3
/* Five job KPIs share a row. Exact at sixty columns, which is why the grid is
   sixty — see the note at GRID_COLS. */
const FIFTH = GRID_COLS / 5

/**
 * The curated default layout — what a new user sees and what "Reset layout"
 * restores. Added to each y so the arrangement survives a change to KPI_H.
 */
export const WIDGETS: WidgetDef[] = [
  ...KPI_WIDGETS,
  /*
   * ── THE ROWS BELOW THE KPIs ─────────────────────────────────────────────
   *
   * Captured from a real arrangement rather than reasoned out a widget at a
   * time, which is why it reads as rows: the whole screen was dragged into
   * shape and then written down. Six bands, each answering one question:
   *
   *   trend      perDay | perHour              how the money moved
   *   volume     countPerDay | topProducts     what actually sold
   *   ranking    topDepartments               (topProducts is double height
   *                                            and runs beside both)
   *   people     topCashiers | voidsAndReturns who rang it, and who undid it
   *   today      attention · reorder · pipeline · tenderTypes
   *   owed       creditorsAgeing | debtorsAgeing · cashPosition
   *
   * The as-at band sits BELOW the trading figures here, not above them. That
   * is a deliberate reversal of the first arrangement: the action list led,
   * on the argument that a dashboard should open on what needs doing. In
   * practice the trading figures are what the screen is opened for every
   * morning, and the four as-at panels read better as a row of equal quarters
   * than as one tall box competing with a chart.
   */
  {
    id: 'perDay',
    title: 'Turnover per day',
    default: { x: 0, y: KPI_BLOCK_H, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /* Beside the daily trend rather than full width below it: the two are the
       same question at two scales — which days, and which hours of a day. */
    id: 'perHour',
    title: 'Sales per hour',
    default: { x: HALF, y: KPI_BLOCK_H, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /* The sale-count series was already in the payload and plotted nowhere.
       Its own chart rather than a second axis on the turnover one: a dual axis
       implies the two lines share a scale, and these do not. */
    id: 'countPerDay',
    title: 'Sales per day',
    default: { x: 0, y: KPI_BLOCK_H + 5, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /* DOUBLE height, and the only widget that is. The product ranking is the
       longest list on the screen and the one most worth scrolling; at ten rows
       it shows about a dozen lines without scrolling at all, and it runs down
       the right of both the count chart and the department ranking. */
    id: 'topProducts',
    title: 'Top products',
    default: { x: HALF, y: KPI_BLOCK_H + 5, w: HALF, h: 10, minW: QUARTER, minH: 5 },
  },
  {
    id: 'topDepartments',
    title: 'Top departments',
    default: { x: 0, y: KPI_BLOCK_H + 10, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /*
     * The as-at band: four panels of what is true right now, in a row.
     *
     * A quarter each, so they read as one band rather than four unrelated
     * boxes. Seven rows because the action list and the reorder table both
     * need room for several lines, and the tender donut cannot draw below six.
     */
    id: 'attention',
    title: 'Needs attention',
    default: { x: 0, y: KPI_BLOCK_H + 15, w: QUARTER, h: 7, minW: QUARTER, minH: 4 },
    scope: 'asAt',
  },
  {
    id: 'reorder',
    title: 'Reorder',
    default: { x: QUARTER, y: KPI_BLOCK_H + 15, w: QUARTER, h: 7, minW: QUARTER, minH: 4 },
    scope: 'asAt',
    capability: 'purchasing.view',
  },
  {
    id: 'pipeline',
    title: 'Pipeline',
    default: { x: HALF, y: KPI_BLOCK_H + 15, w: QUARTER, h: 7, minW: QUARTER, minH: 3 },
    scope: 'asAt',
    capability: 'sales.view',
  },
  {
    /* Ends the band. SEVEN rows tall like its neighbours, and three (the KPI
       height) is the cautionary tale: the card was ~140px, leaving the donut
       ~60px to draw in, so it rendered nothing at all while its legend and
       total showed fine. minH keeps that floor. */
    id: 'tenderTypes',
    title: 'Tender mix',
    default: { x: THREE_QUARTERS, y: KPI_BLOCK_H + 15, w: QUARTER, h: 7, minW: QUARTER, minH: 6 },
  },
  {
    id: 'topCashiers',
    title: 'Top cashiers',
    default: { x: 0, y: KPI_BLOCK_H + 22, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /* Beside the cashier ranking, because both answer "who is doing what" —
       one by turnover, one by what they had to undo. */
    id: 'voidsAndReturns',
    title: 'Voids and returns',
    default: { x: HALF, y: KPI_BLOCK_H + 22, w: HALF, h: 5, minW: QUARTER, minH: 4 },
    capability: 'reports.view',
  },
  {
    /*
     * What we owe, beside what we are owed — creditors on the LEFT.
     *
     * The pairing is the point: two strips of the same shape let the eye
     * compare them without reading a figure. Half the grid each gives every
     * cell ~140px, which fits "R1 819 713.18" on one line; at a quarter they
     * wrapped, which is what made an earlier version stack them full width.
     */
    id: 'creditorsAgeing',
    title: 'Creditors ageing',
    default: { x: 0, y: KPI_BLOCK_H + 27, w: HALF, h: 4, minW: HALF, minH: 3 },
    scope: 'asAt',
    capability: 'suppliers.view',
  },
  {
    id: 'debtorsAgeing',
    title: 'Debtors ageing',
    default: { x: HALF, y: KPI_BLOCK_H + 27, w: HALF, h: 4, minW: HALF, minH: 3 },
    scope: 'asAt',
    capability: 'customers.view',
  },
  {
    /* Under the creditors strip, because both are the same question — what is
       owed, and what there is to pay it with. */
    id: 'cashPosition',
    title: 'Cash position',
    default: { x: 0, y: KPI_BLOCK_H + 31, w: HALF, h: 4, minW: QUARTER, minH: 3 },
    scope: 'asAt',
    capability: 'cashbook.view',
  },

  /* ── Job cards ───────────────────────────────────────────────────────────
   *
   * The PRD asks for an Operations dashboard and a Scheduling dashboard. They
   * are widgets here rather than two more pages, because this grid is already
   * per-person: a dispatcher drags the job widgets up and hides the tender mix,
   * a shop owner does the reverse, and neither has to learn a second screen.
   *
   * All of them are scope 'asAt' and gated on jobs.view. A job board is a
   * picture of RIGHT NOW — "how many jobs were open last Tuesday" is a question
   * nobody asks, and answering it against a date range would need a history
   * table that does not exist.
   *
   * They are added WITHOUT bumping the storage key, deliberately. A new id is
   * not in anybody saved layout, so it lands at its default and every existing
   * arrangement is left exactly as its owner tuned it.
   */
  {
    id: 'jobsOpen',
    title: 'Open jobs',
    default: { x: 0, y: KPI_BLOCK_H + 35, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    /*
     * Also a row in the attention list, and deliberately not removed from
     * there.
     *
     * They answer different questions. The attention row appears only when the
     * count is NON-ZERO — it is a to-do list, and a to-do list that lists things
     * already done is noise. This tile shows the figure either way, which is the
     * only place a dispatcher can see "0" and be reassured rather than left
     * wondering whether the row is missing or the answer is none.
     */
    id: 'jobsUnassigned',
    title: 'Nobody assigned',
    default: { x: FIFTH, y: KPI_BLOCK_H + 35, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsInProgress',
    title: 'Work under way',
    default: { x: FIFTH * 2, y: KPI_BLOCK_H + 35, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsAwaitingParts',
    title: 'Waiting on parts',
    default: { x: FIFTH * 3, y: KPI_BLOCK_H + 35, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    /*
     * The cash-flow figure, and the one worth putting on a dashboard at all.
     *
     * It counts CLOSED jobs still carrying billable lines — not simply closed
     * jobs with no invoice. A warranty call with nothing chargeable on it is
     * finished, not outstanding, and counting it would put permanent noise on
     * the number somebody is supposed to act on.
     */
    id: 'jobsNotInvoiced',
    title: 'Done, not billed',
    default: { x: FIFTH * 4, y: KPI_BLOCK_H + 35, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.invoice',
    module: 'job_cards',
  },
  {
    id: 'jobsByStatus',
    title: 'Jobs by stage',
    default: { x: 0, y: KPI_BLOCK_H + 35 + KPI_H, w: HALF, h: 6, minW: QUARTER, minH: 4 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsByTechnician',
    title: 'Jobs by technician',
    default: { x: HALF, y: KPI_BLOCK_H + 35 + KPI_H, w: HALF, h: 6, minW: QUARTER, minH: 4 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
]

export const ALL_WIDGET_IDS: WidgetId[] = WIDGETS.map((w) => w.id)

/**
 * Bump this when the DEFAULT sizes change. A saved layout always wins over the
 * defaults, so without a new key an existing user would keep the old
 * arrangement forever and never see the improvement.
 */
/* v2: KPI tiles went from 2 columns to 3, because at 2 every money figure
   truncated. A saved v1 layout would pin an existing user to the broken
   width for ever.
   v3: figures paired onto shared tiles — turnover carries its excl reading,
   sales carries items-per-sale — leaving four KPIs on one row, and the grid
   went from 12 columns to 60 so halves, thirds, quarters and fifths are all
   whole numbers. Every saved x/w is in the OLD twelfths, so a v2 layout read
   against a 60-column grid would squeeze the whole dashboard into its left
   fifth.
   v4: the pairs were split back apart — six tiles, three to a row, a third of
   the grid each. A saved v3 layout would keep four quarter-width tiles on one
   row and drop the two new ones underneath at their default x, which is a
   worse arrangement than either version was.
   v5: KPI tiles went from four rows to three and became resizable. Only the
   height actually changed, but a v4 layout would hold every tile at 220px —
   the exact complaint the change answers.
   v6: the dashboard stopped being sales-only. Eight widgets were added, and
   the action list took the left third of the first row below the KPIs — which
   moved `perDay` from two-thirds at x:0 to a third at x:THIRD, and pushed
   everything below it down. Adding widgets alone would NOT need a bump
   (loadPrefs gives a new id its default slot), but moving an existing one
   does: a v5 layout would keep the turnover chart across the left two-thirds
   and drop the action list on top of it, which is the one position that
   defeats the point of adding it.
   v7: the whole arrangement was rebuilt by dragging it and captured back — see
   the row-by-row comment on WIDGETS. Every widget moved, the KPIs went from
   three-and-three to all six on one row, and the as-at panels became a band of
   quarters below the trading figures instead of a tall box above them. A v6
   layout would keep every one of those old positions, which is the entire
   thing this version changes. */
export const STORAGE_KEY = 'odyssey-sales-dashboard-v7'

export type DashboardPrefs = {
  layout: LayoutItem[]
  hidden: WidgetId[]
}

function itemFor(w: WidgetDef): LayoutItem {
  return {
    i: w.id,
    ...w.default,
    ...(w.resizable === false ? { isResizable: false } : {}),
  }
}

export function defaultLayout(): LayoutItem[] {
  return WIDGETS.map(itemFor)
}

/**
 * Read the saved layout, reconciled against the registry.
 *
 * The merge matters: a widget added in a later release has no saved entry, and
 * without this it would simply never appear for anyone who had already used
 * the dashboard. Unknown ids are dropped for the mirror-image reason.
 */
export function loadPrefs(): DashboardPrefs {
  if (typeof window === 'undefined') return { layout: defaultLayout(), hidden: [] }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { layout: defaultLayout(), hidden: [] }

    const parsed = JSON.parse(raw) as Partial<DashboardPrefs>
    const saved = new Map((parsed.layout ?? []).map((l) => [l.i, l]))
    const layout = WIDGETS.map((w) => {
      const item = saved.get(w.id)
      if (!item) return itemFor(w)
      // The registry decides this, not the saved copy — in BOTH directions. A
      // widget that became fixed-size must not stay resizable because of a
      // stale saved flag, and one that became resizable (the KPI tiles) must
      // not stay locked because it was saved while it was not.
      //
      // Only the veto is written. Setting `isResizable: true` here would ALSO
      // override the grid's own `resizeConfig.enabled`, which is what gates
      // resizing on edit mode: react-grid-layout takes a per-item boolean over
      // the grid-level flag, so a `true` saved onto every widget left the
      // resize corners live on a dashboard that was only being read. Dropping
      // the key entirely hands that decision back to edit mode.
      const { isResizable: _stale, ...rest } = item
      return w.resizable === false ? { ...rest, isResizable: false } : rest
    })
    const hidden = (parsed.hidden ?? []).filter((id): id is WidgetId =>
      ALL_WIDGET_IDS.includes(id as WidgetId),
    )
    return { layout, hidden }
  } catch {
    return { layout: defaultLayout(), hidden: [] }
  }
}

export function savePrefs(prefs: DashboardPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* quota exceeded or storage disabled — the layout just won't persist */
  }
}

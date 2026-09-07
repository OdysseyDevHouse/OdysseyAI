import type { LayoutItem } from 'react-grid-layout'

/**
 * The widget registry — the single source of truth for what the dashboard can
 * show, what each widget is called, and where it sits by default.
 *
 * A widget is the unit the grid lays out AND the unit the panel switches. The
 * two headline rows are each ONE widget rather than ten — see the note at the
 * `kpis` entry for why a band of figures cannot be built out of separate grid
 * items — and everything below them is one widget per panel.
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
  /* The headline band. ONE widget — the six figures inside it are cells, not
     widgets: they are not laid out, and they switch on and off together. See
     the note at the `kpis` entry in WIDGETS. */
  | 'kpis'
  /* The rates band under it — one widget, not four. See SecondaryStrip for why
     these four do not get a tile each. */
  | 'rates'
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

/**
 * What SHAPE a widget is, shown as a pill beside its name in the panel.
 *
 * The catalogue is past twenty entries, and a plain list of titles makes
 * somebody read every one to find "the turnover chart". The pill answers
 * "what will this look like on my dashboard" before the title has to.
 *
 * Deliberately about form, not subject — the group heading already says the
 * subject. A dashboard is chosen by shape as much as by topic: a store that
 * wants two more charts and no more tables can now see which is which.
 */
export type WidgetKind = 'kpi' | 'graph' | 'table' | 'list'

/**
 * Which section of the widget panel a widget is listed under.
 *
 * Grouping only — it changes nothing about the layout, and a widget can sit
 * anywhere on the grid regardless of the section it was switched on from.
 */
export type WidgetGroup = 'trading' | 'backOffice' | 'jobs'

/**
 * The sections, in the order the panel lists them.
 *
 * Trading first because it is what the dashboard is for and what everyone has;
 * job cards last because a shop without the module never sees the section at
 * all — the panel drops a group whose every widget is out of reach.
 */
export const WIDGET_GROUPS: { id: WidgetGroup; title: string; note: string }[] = [
  { id: 'trading', title: 'Trading', note: 'What the shop sold in the period above' },
  { id: 'backOffice', title: 'Back office', note: 'Money owed, money held, stock to order — as at today' },
  { id: 'jobs', title: 'Job cards', note: 'The job board, as at today' },
]

export type WidgetDef = {
  id: WidgetId
  title: string
  /** Its section in the widget panel. Listing only — see WidgetGroup. */
  group: WidgetGroup
  /** Its shape, shown as a pill in the panel. See WidgetKind. */
  kind: WidgetKind
  default: Pick<LayoutItem, 'x' | 'y' | 'w' | 'h' | 'minW' | 'minH'>
  /** Fixed-size widgets can be dragged but not resized. */
  resizable?: boolean
  /**
   * OFF until somebody turns it on, rather than absent.
   *
   * The difference from `capability`/`module` matters: those say the widget
   * could never fill, and it is not offered at all. This one says the widget
   * works fine and most shops do not want it on the first screen they see
   * every morning — the job board, the ageings, what is in the tills. They are
   * listed in the Widgets panel with their switch off, one click from being
   * back, and they keep their place in the default layout so turning one on
   * puts it where it belongs instead of at the bottom.
   *
   * The bar for setting this is "a real shop, asked, said no". It is not a way
   * to ship a widget nobody thought through.
   */
  hiddenByDefault?: boolean
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
 * The cells of the headline band, in the order they appear — one row, so the
 * order is the reading order, left to right.
 *
 * Money first and widening: what was taken, what of it is the shop's, what was
 * made on it, and at what margin. Then the shape of the basket behind that
 * money — how big, and how full.
 *
 * The sale COUNT is not on this row. It is the denominator under the average
 * sale and the items per sale rather than a headline of its own, and it opens
 * the rates band immediately below, beside the per-day and per-hour readings
 * that are the only useful things to divide it by. Its old tile went to the GP
 * percentage, which had been riding in brackets on the gross profit figure and
 * so had no comparison of its own.
 */
export const KPI_IDS = [
  'turnoverIncl',
  'turnoverExcl',
  'grossProfit',
  'grossProfitPct',
  'avgSaleValue',
  'avgItemsPerSale',
] as const

export type KpiId = (typeof KPI_IDS)[number]

/* The cells' own LABELS live in KpiStrip, beside the value each one formats.
   They were briefly duplicated here for the widget panel, which no longer
   lists them — and a title kept in two files is a title that disagrees with
   itself the first time one is reworded. */

/*
 * ONE BAND, not six tiles — and this is the third time the width of these
 * figures has been rethought, so the reasoning is worth writing down.
 *
 * They were six widgets: six cards, each with its own border and its own 20px
 * of grid gutter on either side. That made six objects across the top of a
 * screen whose entire job is to be glanced at, and no two of them lined up —
 * every gap was a little step for the eye to climb over.
 *
 * A headline strip reads as ONE band cut into cells. The figures sit on a
 * common baseline, the hairlines between them are a divider rather than a
 * frame, and the row scans left to right in a single movement. That look is
 * simply not reachable from six grid items: react-grid-layout puts a fixed
 * gutter between every cell it lays out, so as long as the tiles are separate
 * widgets they cannot touch.
 *
 * So the band is the widget. It is what moves, resizes and hides, exactly like
 * the rates band underneath it — same argument, one step earlier: six readings
 * of one period's trade only mean anything read together.
 *
 * The band switches ALL OR NOTHING, like the rates band under it. There was a
 * switch per figure for a while, on the argument that a store which never looks
 * at items-per-sale should be able to drop that cell. It came out again: six
 * extra switches, indented under a seventh that already turns the row off, is
 * most of the reason the panel had become a wall of toggles — and hiding one
 * cell of six makes the band's own proportions worse, not better. The row is
 * one thought; it goes on or off as one.
 */
// Two grid rows — 100px — because a cell is now three lines of text and
// nothing else. This went 4 -> 3 while the tiles still carried a sparkline;
// dropping the chart (see KpiStrip) took the last 60px with it.
//
// The arithmetic, so a future change can check it rather than guess: 12px of
// padding top and bottom, 16 for the caption, 4 gap, 30 for the figure at
// text-2xl, 6 gap, 16 for the note — 96px of content in a 100px cell. A cell
// centres its block, so the 4px spare falls evenly above and below rather than
// pooling under the note.
const KPI_H = 2

/**
 * Height of the headline band. One row of cells, so one band height.
 *
 * Still named rather than written as `2` at every y below it, so changing the
 * band's height moves the whole dashboard with it.
 */
const KPI_ROWS_H = KPI_H

/**
 * The rates band under the tiles — full width, two rows.
 *
 * Two rows (100px) is what the band needs at its four-column shape: a cell is
 * label-and-figure on one line with the divisor under it, about 62px of
 * content, and the widget has no header to pay for. It is a floor as well as a
 * default — dragged shorter the band would clip its own hint line, which is
 * the half that says what each rate was divided by.
 */
const RATES_H = 2

/**
 * Where the rest of the dashboard starts.
 *
 * The tiles fill their row exactly and the rates band fills the row under
 * them, so this is simply the bottom of the whole headline block.
 */
const KPI_BLOCK_H = KPI_ROWS_H + RATES_H

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
  {
    /*
     * The headline band. Full width, headerless, and first.
     *
     * A minW of a half rather than the whole grid: dragged narrower the cells
     * wrap to three and then to two rows of the same band, which is the shape
     * the phone already shows. Below half a screen the figures would be
     * stepping down type sizes to fit, which is the point at which the band
     * stops being a glance.
     */
    id: 'kpis',
    group: 'trading',
    kind: 'kpi',
    title: 'Trading figures',
    default: { x: 0, y: 0, w: GRID_COLS, h: KPI_H, minW: GRID_COLS / 2, minH: KPI_H },
  },
  {
    /*
     * The rates band, directly under the tiles it divides.
     *
     * Full width and headerless — see SecondaryStrip. Its position is the
     * point: "R33 548 a day" is a comment on the turnover tile above it, and
     * the two have to be readable in one glance or the band is just four more
     * numbers. It is still a widget, so a shop that only wants period totals
     * can switch it off.
     */
    id: 'rates',
    group: 'trading',
    kind: 'kpi',
    title: 'Rates',
    default: { x: 0, y: KPI_ROWS_H, w: GRID_COLS, h: RATES_H, minW: HALF, minH: RATES_H },
  },
  /*
   * ── THE ROWS BELOW THE HEADLINE BLOCK ───────────────────────────────────
   *
   * Captured from a real arrangement rather than reasoned out a widget at a
   * time, which is why it reads as rows: the whole screen was dragged into
   * shape and then written down. Seven bands, each answering one question:
   *
   *   trend    perDay | perHour | countPerDay     how the money moved
   *   sold     topDepartments | topProducts       what actually sold
   *   people   topCashiers | voidsAndReturns      who rang it, who undid it
   *   today    attention · reorder · pipeline · tenderTypes
   *   owed     creditorsAgeing | debtorsAgeing    what is owed
   *   held     cashPosition                       what is in the tills and banks
   *   jobs     five counts, then two breakdowns   the job board
   *
   * THREE CHARTS ACROSS, not two and a stray. The three time charts answer one
   * question between them — how the money moved through the period — and a
   * third of the grid is still ~430px, which is a real chart. Read as a row
   * they compare; split across two bands, as they were, the sales-count chart
   * sat under a ranked table and looked like a footnote to it.
   *
   * The as-at band sits BELOW the trading figures, not above them. That is a
   * deliberate reversal of the first arrangement: the action list led, on the
   * argument that a dashboard should open on what needs doing. In practice the
   * trading figures are what the screen is opened for every morning.
   *
   * Every y is written off KPI_BLOCK_H rather than as a number, so a change to
   * the headline block's height moves the whole page with it instead of
   * leaving a gap or an overlap at the top.
   */
  {
    /* SIX rows, where every other chart takes five.
       These two now carry furniture the others do not: the bar chart has a
       legend above it (two fills and the average rule) and both have a
       takeaway line below. At five rows that came straight out of the plot,
       leaving the bars about 120px to draw in. The extra row is the furniture's
       height, so the chart itself is no smaller than it was. */
    id: 'perDay',
    group: 'trading',
    kind: 'graph',
    title: 'Turnover per day',
    default: { x: 0, y: KPI_BLOCK_H, w: THIRD, h: 6, minW: QUARTER, minH: 5 },
  },
  {
    /* Beside the daily trend rather than full width below it: the two are the
       same question at two scales — which days, and which hours of a day. */
    id: 'perHour',
    group: 'trading',
    kind: 'graph',
    title: 'Sales per hour',
    default: { x: THIRD, y: KPI_BLOCK_H, w: THIRD, h: 6, minW: QUARTER, minH: 5 },
  },
  {
    /* The sale-count series was already in the payload and plotted nowhere.
       Its own chart rather than a second axis on the turnover one: a dual axis
       implies the two lines share a scale, and these do not. */
    id: 'countPerDay',
    group: 'trading',
    kind: 'graph',
    title: 'Sales per day',
    default: { x: TWO_THIRDS, y: KPI_BLOCK_H, w: THIRD, h: 6, minW: QUARTER, minH: 5 },
  },
  {
    /* DOUBLE height, and the only widget that is. The product ranking is the
       longest list on the screen and the one most worth scrolling; at ten rows
       it shows about a dozen lines without scrolling at all, and it runs down
       the right of both the count chart and the department ranking. */
    id: 'topProducts',
    group: 'trading',
    kind: 'table',
    title: 'Top products',
    default: { x: HALF, y: KPI_BLOCK_H + 6, w: HALF, h: 6, minW: QUARTER, minH: 5 },
  },
  {
    id: 'topDepartments',
    group: 'trading',
    kind: 'table',
    title: 'Top departments',
    default: { x: 0, y: KPI_BLOCK_H + 6, w: HALF, h: 6, minW: QUARTER, minH: 5 },
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
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'list',
    title: 'Needs attention',
    default: { x: 0, y: KPI_BLOCK_H + 17, w: QUARTER, h: 7, minW: QUARTER, minH: 4 },
    scope: 'asAt',
  },
  {
    id: 'reorder',
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'table',
    title: 'Reorder',
    default: { x: QUARTER, y: KPI_BLOCK_H + 17, w: QUARTER, h: 7, minW: QUARTER, minH: 4 },
    scope: 'asAt',
    capability: 'purchasing.view',
  },
  {
    id: 'pipeline',
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'list',
    title: 'Pipeline',
    default: { x: HALF, y: KPI_BLOCK_H + 17, w: QUARTER, h: 7, minW: QUARTER, minH: 3 },
    scope: 'asAt',
    capability: 'sales.view',
  },
  {
    /* Ends the band. SEVEN rows tall like its neighbours, and three (the KPI
       height) is the cautionary tale: the card was ~140px, leaving the donut
       ~60px to draw in, so it rendered nothing at all while its legend and
       total showed fine. minH keeps that floor. */
    id: 'tenderTypes',
    hiddenByDefault: true,
    group: 'trading',
    kind: 'graph',
    title: 'Tender mix',
    default: { x: THREE_QUARTERS, y: KPI_BLOCK_H + 17, w: QUARTER, h: 7, minW: QUARTER, minH: 6 },
  },
  {
    id: 'topCashiers',
    group: 'trading',
    kind: 'table',
    title: 'Top cashiers',
    default: { x: 0, y: KPI_BLOCK_H + 12, w: HALF, h: 5, minW: QUARTER, minH: 5 },
  },
  {
    /* Beside the cashier ranking, because both answer "who is doing what" —
       one by turnover, one by what they had to undo. */
    id: 'voidsAndReturns',
    group: 'trading',
    kind: 'table',
    title: 'Voids and returns',
    default: { x: HALF, y: KPI_BLOCK_H + 12, w: HALF, h: 5, minW: QUARTER, minH: 4 },
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
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'kpi',
    title: 'Creditors ageing',
    default: { x: 0, y: KPI_BLOCK_H + 24, w: HALF, h: 4, minW: HALF, minH: 3 },
    scope: 'asAt',
    capability: 'suppliers.view',
  },
  {
    id: 'debtorsAgeing',
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'kpi',
    title: 'Debtors ageing',
    default: { x: HALF, y: KPI_BLOCK_H + 24, w: HALF, h: 4, minW: HALF, minH: 3 },
    scope: 'asAt',
    capability: 'customers.view',
  },
  {
    /* Under the creditors strip, because both are the same question — what is
       owed, and what there is to pay it with. */
    id: 'cashPosition',
    hiddenByDefault: true,
    group: 'backOffice',
    kind: 'list',
    title: 'Cash position',
    default: { x: 0, y: KPI_BLOCK_H + 28, w: HALF, h: 4, minW: QUARTER, minH: 3 },
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
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'kpi',
    title: 'Open jobs',
    default: { x: 0, y: KPI_BLOCK_H + 32, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
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
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'kpi',
    title: 'Nobody assigned',
    default: { x: FIFTH, y: KPI_BLOCK_H + 32, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsInProgress',
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'kpi',
    title: 'Work under way',
    default: { x: FIFTH * 2, y: KPI_BLOCK_H + 32, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsAwaitingParts',
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'kpi',
    title: 'Waiting on parts',
    default: { x: FIFTH * 3, y: KPI_BLOCK_H + 32, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
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
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'kpi',
    title: 'Done, not billed',
    default: { x: FIFTH * 4, y: KPI_BLOCK_H + 32, w: FIFTH, h: KPI_H, minW: FIFTH, minH: 2 },
    scope: 'asAt',
    capability: 'jobs.invoice',
    module: 'job_cards',
  },
  {
    id: 'jobsByStatus',
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'graph',
    title: 'Jobs by stage',
    default: { x: 0, y: KPI_BLOCK_H + 32 + KPI_H, w: HALF, h: 6, minW: QUARTER, minH: 4 },
    scope: 'asAt',
    capability: 'jobs.view',
    module: 'job_cards',
  },
  {
    id: 'jobsByTechnician',
    hiddenByDefault: true,
    group: 'jobs',
    kind: 'graph',
    title: 'Jobs by technician',
    default: { x: HALF, y: KPI_BLOCK_H + 32 + KPI_H, w: HALF, h: 6, minW: QUARTER, minH: 4 },
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
   thing this version changes.
   v8: the rates band was added under the KPI tiles, which pushed every widget
   below it down two rows. Adding a widget alone would NOT need a bump —
   loadPrefs drops a new id into its default slot — but a new FULL-WIDTH band
   landing in a saved layout that still has the turnover chart at that y would
   have the grid shove the charts aside to make room, and an arrangement
   rearranged by collision is worse than one that was never tuned.
   v9: the KPI tiles lost their sparklines and gained a note line, which took
   them from three grid rows to two, and the sales-count tile was replaced by a
   GP percentage tile — the count moved into the rates band below. Both halves
   need the bump. A v8 layout would hold every tile at its old 160px, leaving
   the 60px of white the change exists to reclaim, and would drop the new
   grossProfitPct tile into its default slot UNDERNEATH a row that is still
   full, putting one KPI on a line of its own.
   v10: the six KPI tiles became ONE band widget, `kpis`. A v9 layout holds six
   separate tiles at the ids that no longer lay out — loadPrefs drops them —
   and has nothing at 'kpis', which would drop the band into its default slot
   on top of a row the saved layout still thinks is occupied.
   v11: the whole arrangement below the headline block was rebuilt by dragging
   it and captured back — three time charts on one row, the ranked tables
   paired, and every band below moved up by the rows that freed. A v10 layout
   keeps every old position, which is the entire thing this changes. */
export const STORAGE_KEY = 'odyssey-sales-dashboard-v11'

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
 * What a dashboard nobody has touched has switched OFF.
 *
 * The opening screen is the trading figures and the charts that explain them:
 * two headline bands, three time charts, four ranked tables. Everything else —
 * the job board, what is owed, what is held, the action list — is real and one
 * click away in the Widgets panel, but it is not what the shop opens the app to
 * look at, and a dashboard that has to be scrolled past to be read is a
 * dashboard nobody reads.
 *
 * Derived from the registry rather than written out here, so a widget added
 * with `hiddenByDefault` cannot be forgotten in a second list.
 */
export function defaultHidden(): WidgetId[] {
  return WIDGETS.filter((w) => w.hiddenByDefault).map((w) => w.id)
}

/**
 * Read the saved layout, reconciled against the registry.
 *
 * The merge matters: a widget added in a later release has no saved entry, and
 * without this it would simply never appear for anyone who had already used
 * the dashboard. Unknown ids are dropped for the mirror-image reason.
 */
export function loadPrefs(): DashboardPrefs {
  if (typeof window === 'undefined') return { layout: defaultLayout(), hidden: defaultHidden() }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { layout: defaultLayout(), hidden: defaultHidden() }

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
    return { layout: defaultLayout(), hidden: defaultHidden() }
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

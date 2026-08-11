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
  | 'tenderTypes'
  | 'topProducts'
  | 'topDepartments'
  | 'topCashiers'

export type WidgetDef = {
  id: WidgetId
  title: string
  default: Pick<LayoutItem, 'x' | 'y' | 'w' | 'h' | 'minW' | 'minH'>
  /** Fixed-size widgets can be dragged but not resized. */
  resizable?: boolean
}

/**
 * The KPI ids, in the order they appear — three to a row, so the order is also
 * the grouping.
 *
 * Row one is the money: what was taken, what of it is the shop's, what was made
 * on it. Row two is the shape of the trade behind that money: how many baskets,
 * how big, how full. Read across, each row is one thought.
 */
export const KPI_IDS = [
  'turnoverIncl',
  'turnoverExcl',
  'grossProfit',
  'saleCount',
  'avgSaleValue',
  'avgItemsPerSale',
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

// Six KPIs, THREE to a row — not six across.
//
// The width is the whole history of this file. Six tiles at a twelfth of the
// grid truncated every money figure to "R2 658 …"; a fifth each fitted but was
// tight (~246px at 1600, ~200px at 1366). Six across is roughly a fifth again:
// about 196px at a 1600 viewport and 163px at 1366, which is under the width
// "R860 025.54 (36.5%)" needs even at the smallest type size the tile will use.
// Nothing truncates any more — it wraps onto a second line instead and eats the
// trend chart — but that is still the wrong shape.
//
// A third of sixty columns is ~413px at 1600 and ~333px at 1366, which every
// figure clears at full size, and three-and-three is the grouping the numbers
// already have (see KPI_IDS). The cost is one extra grid row of height, which
// is the cheaper thing to spend.
const KPI_PER_ROW = 3
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

/** Height of the KPI tiles themselves. */
const KPI_ROWS_H = Math.ceil(KPI_IDS.length / KPI_PER_ROW) * KPI_H

/**
 * Where the rest of the dashboard starts.
 *
 * The tiles fill their rows exactly, so nothing sits beside them and this is
 * simply the bottom of the block.
 */
const KPI_BLOCK_H = KPI_ROWS_H

/* Named fractions of the grid, so a layout reads as "half" rather than as a
   number whose meaning depends on GRID_COLS. All exact at sixty columns. */
const HALF = GRID_COLS / 2
const THIRD = GRID_COLS / 3
const TWO_THIRDS = THIRD * 2
const QUARTER = GRID_COLS / 4

/**
 * The curated default layout — what a new user sees and what "Reset layout"
 * restores. Added to each y so the arrangement survives a change to KPI_H.
 */
export const WIDGETS: WidgetDef[] = [
  ...KPI_WIDGETS,
  {
    id: 'perDay',
    title: 'Turnover per day',
    default: { x: 0, y: KPI_BLOCK_H, w: TWO_THIRDS, h: 7, minW: QUARTER, minH: 5 },
  },
  {
    // Shares the row with the turnover chart, taking the last third.
    //
    // SEVEN rows tall to match it. Its old height was six, and three (the KPI
    // height) is the cautionary tale: the card was ~140px, leaving the donut
    // ~60px to draw in, so it rendered nothing at all while its legend and
    // total showed fine. minH keeps that floor.
    id: 'tenderTypes',
    title: 'Tender mix',
    default: { x: TWO_THIRDS, y: KPI_BLOCK_H, w: THIRD, h: 7, minW: QUARTER, minH: 6 },
  },
  {
    id: 'perHour',
    title: 'Sales per hour',
    default: { x: 0, y: KPI_BLOCK_H + 7, w: GRID_COLS, h: 6, minW: QUARTER, minH: 5 },
  },
  {
    id: 'topProducts',
    title: 'Top products',
    default: { x: 0, y: KPI_BLOCK_H + 13, w: HALF, h: 8, minW: QUARTER, minH: 5 },
  },
  {
    id: 'topDepartments',
    title: 'Top departments',
    default: { x: HALF, y: KPI_BLOCK_H + 13, w: HALF, h: 8, minW: QUARTER, minH: 5 },
  },
  {
    id: 'topCashiers',
    title: 'Top cashiers',
    default: { x: 0, y: KPI_BLOCK_H + 21, w: GRID_COLS, h: 7, minW: QUARTER, minH: 5 },
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
   the exact complaint the change answers. */
export const STORAGE_KEY = 'odyssey-sales-dashboard-v5'

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
      return { ...item, isResizable: w.resizable !== false }
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

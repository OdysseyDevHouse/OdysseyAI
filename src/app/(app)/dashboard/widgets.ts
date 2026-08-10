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
 * Twelve cannot be divided into fifths, and the five KPI tiles have to share
 * one row. Sixty is the smallest count that divides cleanly by 2, 3, 4, 5 and
 * 6, so a half (30), a third (20), a quarter (15) and a fifth (12) are all
 * whole numbers and every existing arrangement still lands on exact columns.
 */
export const GRID_COLS = 60

export type WidgetId =
  | 'turnoverIncl'
  | 'grossProfit'
  | 'saleCount'
  | 'avgSaleValue'
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

/** The KPI ids, in the order they appear across the top row. */
export const KPI_IDS = [
  'turnoverIncl',
  'grossProfit',
  'saleCount',
  'avgSaleValue',
] as const

export type KpiId = (typeof KPI_IDS)[number]

/* Two of these carry a second figure below the headline — turnover its excl
   reading, sales its items-per-sale. See the defs in KpiTile. */
const KPI_TITLES: Record<KpiId, string> = {
  turnoverIncl: 'Turnover',
  grossProfit: 'Gross profit',
  saleCount: 'Sales',
  avgSaleValue: 'Average sale',
}

// All four KPIs on ONE row — a quarter of the grid each.
//
// The history matters here. Six tiles at a twelfth each truncated every money
// figure to "R2 658 …", so they were widened to a quarter and wrapped 4 + 2.
// Pairing turnover incl/excl took that to five on one row at a fifth each,
// which fitted but left the tiles tight (~246px at 1600, ~200px at 1366).
// Pairing sales with items-per-sale takes it to four, and a quarter of sixty
// columns puts them back to roughly 310px at 1600 — comfortably clear of the
// width that caused the original truncation.
const KPI_PER_ROW = 4
const KPI_W = GRID_COLS / KPI_PER_ROW
const KPI_H = 3

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
    minW: KPI_W,
    minH: KPI_H,
  },
  resizable: false,
}))

/** Height of the KPI tiles themselves. */
const KPI_ROWS_H = Math.ceil(KPI_IDS.length / KPI_PER_ROW) * KPI_H

/**
 * Where the rest of the dashboard starts.
 *
 * The tiles fill their row exactly, so nothing sits beside them and this is
 * simply the bottom of that one row.
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
   fifth. */
export const STORAGE_KEY = 'odyssey-sales-dashboard-v3'

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
      // Re-apply the resize rule over the saved flag, so a widget that BECAME
      // fixed-size cannot stay resizable because of a stale saved value.
      return { ...item, isResizable: w.resizable === false ? false : item.isResizable }
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

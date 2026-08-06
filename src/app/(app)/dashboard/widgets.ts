import type { LayoutItem } from 'react-grid-layout'

/**
 * The widget registry — the single source of truth for what the dashboard can
 * show, what each widget is called, and where it sits by default.
 *
 * Each KPI is its OWN widget rather than one "KPI strip" widget, so a store
 * that never looks at average items per sale can hide that one tile and give
 * the room to something it does look at. The grid is 12 columns.
 */

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

/** The KPI ids, in the order they appear across the top row. */
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
  turnoverIncl: 'Turnover (incl)',
  turnoverExcl: 'Turnover (excl)',
  grossProfit: 'Gross profit',
  saleCount: 'Sales',
  avgSaleValue: 'Average sale',
  avgItemsPerSale: 'Items per sale',
}

// THREE columns per tile, not two.
//
// Six 2-column tiles fit the 12-column grid exactly and looked tidy in the
// abstract — but South African money is long ("R2 658 421.55" is 13
// characters) and at that width every headline figure truncated to "R2 658 …".
// A dashboard whose whole job is showing numbers must not hide them.
//
// At w:3 the twelve columns take FOUR tiles per row, so the six wrap 4 + 2.
// The two on the second row sit beside the tender chart rather than leaving a
// gap — see the layout below, which starts that chart on the second KPI row.
const KPI_W = 3
const KPI_H = 3

/** How many fit across the 12-column grid. */
const KPI_PER_ROW = Math.floor(12 / KPI_W)

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
 * The tender chart sits alongside the second KPI row but is taller than it, so
 * this clears whichever of the two reaches further down — otherwise the next
 * widget overlaps the chart.
 */
const TENDER_BOTTOM = KPI_H + 6
const KPI_BLOCK_H = Math.max(KPI_ROWS_H, TENDER_BOTTOM)

/**
 * The curated default layout — what a new user sees and what "Reset layout"
 * restores. Added to each y so the arrangement survives a change to KPI_H.
 */
export const WIDGETS: WidgetDef[] = [
  ...KPI_WIDGETS,
  {
    // Sits in the gap the second KPI row leaves — six tiles across four
    // columns fill 4 + 2, so the last six columns of that row are free.
    //
    // SIX rows tall, not three. At three (the KPI height) the card is ~140px,
    // and after its header and padding the donut had ~60px to draw in — so it
    // rendered nothing at all while its legend and total showed fine. A donut
    // squeezed into 60px would be unreadable anyway; minH enforces the floor.
    id: 'tenderTypes',
    title: 'Tender mix',
    default: { x: 6, y: KPI_H, w: 6, h: 6, minW: 4, minH: 6 },
  },
  {
    id: 'perDay',
    title: 'Turnover per day',
    default: { x: 0, y: KPI_BLOCK_H, w: 12, h: 7, minW: 4, minH: 5 },
  },
  {
    id: 'perHour',
    title: 'Sales per hour',
    default: { x: 0, y: KPI_BLOCK_H + 7, w: 12, h: 6, minW: 4, minH: 5 },
  },
  {
    id: 'topProducts',
    title: 'Top products',
    default: { x: 0, y: KPI_BLOCK_H + 13, w: 6, h: 8, minW: 4, minH: 5 },
  },
  {
    id: 'topDepartments',
    title: 'Top departments',
    default: { x: 6, y: KPI_BLOCK_H + 13, w: 6, h: 8, minW: 4, minH: 5 },
  },
  {
    id: 'topCashiers',
    title: 'Top cashiers',
    default: { x: 0, y: KPI_BLOCK_H + 21, w: 12, h: 7, minW: 4, minH: 5 },
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
   width for ever. */
export const STORAGE_KEY = 'odyssey-sales-dashboard-v2'

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

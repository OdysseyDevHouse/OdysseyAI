'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout'
import {
  Button,
  Card,
  CardHeader,
  DateRangeField,
  EmptyState,
  Icons,
  type DateRange,
} from '@/components/ui'
import type { DetailDimension, SalesDashboardData } from '@/lib/site/salesDashboard'
import {
  GRID_COLS,
  WIDGETS,
  defaultLayout,
  loadPrefs,
  savePrefs,
  type KpiId,
  type WidgetId,
} from './widgets'
import { KPI_BY_ID, KpiTile } from './KpiTile'
import { SalesPerHourChart, TenderMixChart, TurnoverPerDayChart } from './Charts'
import { RankedTable, TABLE_CONFIG } from './RankedTable'
import { WidgetPanel } from './WidgetPanel'
import { DetailModal } from './DetailModal'

import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

/**
 * The sales dashboard.
 *
 * Layout is user-owned: widgets can be moved, resized and hidden, and the
 * arrangement persists per browser. Edit mode is deliberately OFF on load and
 * is not remembered — the dashboard should open calm and read-only, because
 * it is read a hundred times for every time it is rearranged, and a grid that
 * moves under an accidental drag is worse than one that cannot move at all.
 */

// A single breakpoint: the grid measures its own container, and the widths that
// matter (a half-width card, a full-width one) are already expressed in the
// column layout rather than in device breakpoints.
const BREAKPOINTS = { lg: 0 }
const COLS = { lg: GRID_COLS }

/** Which widgets get a "View more" button, and the list it opens. */
const DETAIL_FOR: Partial<Record<WidgetId, DetailDimension>> = {
  topProducts: 'products',
  topDepartments: 'departments',
  topCashiers: 'cashiers',
}

/** Tables scroll inside their box; charts size to fit and must not. */
const SCROLLS: WidgetId[] = ['topProducts', 'topDepartments', 'topCashiers']

const EMPTY: SalesDashboardData = {
  kpis: {
    turnoverIncl: 0,
    turnoverExcl: 0,
    grossProfit: 0,
    grossProfitPct: 0,
    saleCount: 0,
    avgSaleValue: 0,
    avgItemsPerSale: 0,
  },
  compareKpis: null,
  compareLabel: 'vs last month',
  perHour: [],
  perDay: [],
  tenderTypes: [],
  topProducts: [],
  topDepartments: [],
  topCashiers: [],
  hasData: false,
}

/** This month to date — the period a store owner checks most. */
function thisMonth(): DateRange {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
}

export function SalesDashboard() {
  const [range, setRange] = useState<DateRange>(thisMonth)
  const [data, setData] = useState<SalesDashboardData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [detail, setDetail] = useState<DetailDimension | null>(null)

  const [layout, setLayout] = useState<LayoutItem[]>(defaultLayout)
  const [hidden, setHidden] = useState<WidgetId[]>([])
  const [prefsLoaded, setPrefsLoaded] = useState(false)

  // Read by the layout-change handler without making it a dependency — as a
  // dependency it would rebuild the handler on every visibility toggle.
  const hiddenRef = useRef<WidgetId[]>([])
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  // react-grid-layout v2 needs an explicit width; this measures the container.
  const { width, containerRef, mounted } = useContainerWidth()

  useEffect(() => {
    const prefs = loadPrefs()
    setLayout(prefs.layout)
    setHidden(prefs.hidden)
    setPrefsLoaded(true)
  }, [])

  // Refetch whenever the range changes. The id guard drops a slow response for
  // a range the user has already moved on from.
  const requestId = useRef(0)
  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)

    fetch(`/api/dashboard/sales?from=${range.from}&to=${range.to}`)
      .then(async (res) => {
        const body = await res.json()
        if (id !== requestId.current) return
        if (!res.ok) {
          setError(body.error ?? 'Failed to load sales data.')
          setData(EMPTY)
        } else {
          setData(body as SalesDashboardData)
        }
      })
      .catch(() => {
        if (id !== requestId.current) return
        setError('Could not reach the server.')
        setData(EMPTY)
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [range.from, range.to])

  const onLayoutChange = useCallback((next: Layout) => {
    // The grid only reports VISIBLE widgets. Merge their positions back into
    // the full layout so a hidden widget returns to where it was, rather than
    // to the default slot, when it is shown again.
    const moved = new Map(next.map((l) => [l.i, { ...l }]))
    setLayout((prev) => {
      const merged = prev.map((item) => moved.get(item.i) ?? item)
      savePrefs({ layout: merged, hidden: hiddenRef.current })
      return merged
    })
  }, [])

  const toggleWidget = useCallback((id: WidgetId) => {
    setHidden((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      // Read the layout fresh rather than closing over a stale copy.
      setLayout((current) => {
        savePrefs({ layout: current, hidden: next })
        return current
      })
      return next
    })
  }, [])

  const resetLayout = useCallback(() => {
    const fresh = defaultLayout()
    setLayout(fresh)
    setHidden([])
    savePrefs({ layout: fresh, hidden: [] })
  }, [])

  const visibleLayout = useMemo(
    () => layout.filter((l) => !hidden.includes(l.i as WidgetId)),
    [layout, hidden],
  )

  function widgetBody(id: WidgetId) {
    switch (id) {
      case 'perHour':
        return <SalesPerHourChart data={data.perHour} />
      case 'perDay':
        return <TurnoverPerDayChart data={data.perDay} />
      case 'tenderTypes':
        return <TenderMixChart data={data.tenderTypes} />
      case 'topProducts':
        return <RankedTable rows={data.topProducts} config={TABLE_CONFIG.products} />
      case 'topDepartments':
        return <RankedTable rows={data.topDepartments} config={TABLE_CONFIG.departments} />
      case 'topCashiers':
        return <RankedTable rows={data.topCashiers} config={TABLE_CONFIG.cashiers} />
      default:
        return null
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Chrome: roomy, because this is the part that gets clicked. */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-border bg-surface px-4 py-3.5">
        <div className="flex items-end gap-3">
          <DateRangeField value={range} onChange={setRange} label="Period" />
          <Button variant="ghost" onClick={() => setRange(thisMonth())}>
            <Icons.Refresh size={15} />
            This month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-muted">Loading…</span>}
          {editing && (
            <Button variant="secondary" onClick={() => setPanelOpen(true)}>
              <Icons.LayoutGrid size={15} />
              Widgets
            </Button>
          )}
          <Button
            variant={editing ? 'primary' : 'secondary'}
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
          >
            {editing ? <Icons.Check size={15} /> : <Icons.Pencil size={15} />}
            {editing ? 'Done' : 'Edit layout'}
          </Button>
        </div>
      </div>

      {editing && (
        <p className="rounded-card border border-brand bg-brand-soft px-4 py-2.5 text-sm text-brand">
          Drag a widget by its header to move it, or drag its bottom-right corner to resize.
          Changes save as you go.
        </p>
      )}

      {error && (
        <div className="rounded-card border border-danger bg-danger-soft px-4 py-3">
          <p className="text-sm font-semibold text-danger-ink">Couldn&apos;t load sales data</p>
          <p className="mt-0.5 text-sm text-danger-ink">{error}</p>
        </div>
      )}

      {!error && !loading && !data.hasData && (
        <div className="rounded-card border border-border bg-surface">
          <EmptyState
            icon={<Icons.Receipt size={22} />}
            title="No sales in this period"
            hint="Nothing was finalised between these dates. Try a wider range."
          />
        </div>
      )}

      <div ref={containerRef}>
        {prefsLoaded && mounted && (
          <ResponsiveGridLayout
            className="layout"
            width={width}
            layouts={{ lg: visibleLayout }}
            breakpoints={BREAKPOINTS}
            cols={COLS}
            rowHeight={40}
            margin={[20, 20]}
            // Default padding equals `margin`, which would inset the grid and
            // leave it narrower than the toolbar above it.
            containerPadding={[0, 0]}
            dragConfig={{ enabled: editing, bounded: false, handle: '.widget-drag', threshold: 3 }}
            resizeConfig={{ enabled: editing, handles: ['se'] }}
            onLayoutChange={onLayoutChange}
          >
            {WIDGETS.filter((w) => !hidden.includes(w.id)).map((w) => {
              // Undefined for the charts and tables, which take the Card path
              // below. The map is keyed by KpiId, so this is the lookup that
              // decides which of the two a widget is.
              const kpi = KPI_BY_ID.get(w.id as KpiId)

              // A KPI tile is its own card, so it gets no Card chrome. In edit
              // mode the whole tile is the drag handle — it has no header to
              // grab. That does not swallow the resize corner: the grid's own
              // drag cancels on `.react-resizable-handle`, so the handle inside
              // this element still resizes rather than dragging.
              if (kpi) {
                return (
                  <div
                    key={w.id}
                    className={editing ? 'widget-drag cursor-move rounded-card ring-1 ring-brand' : ''}
                  >
                    <KpiTile
                      def={kpi}
                      kpis={data.kpis}
                      compareKpis={data.compareKpis}
                      compareLabel={data.compareLabel}
                      perDay={data.perDay}
                      loading={loading}
                    />
                  </div>
                )
              }

              const dimension = DETAIL_FOR[w.id]
              return (
                <div key={w.id}>
                  <Card
                    className={`flex h-full flex-col overflow-hidden ${
                      editing ? 'ring-1 ring-brand' : ''
                    }`}
                  >
                    <CardHeader
                      className={editing ? 'widget-drag cursor-move select-none' : ''}
                      title={
                        <span className="flex items-center gap-1.5">
                          {editing && <Icons.ArrowLeftRight size={14} className="text-brand" />}
                          {w.title}
                        </span>
                      }
                      action={
                        dimension && !editing ? (
                          <Button variant="ghost" size="sm" onClick={() => setDetail(dimension)}>
                            View more
                            <Icons.ArrowRight size={14} />
                          </Button>
                        ) : undefined
                      }
                    />
                    <div
                      className={`min-h-0 flex-1 ${
                        SCROLLS.includes(w.id) ? 'overflow-auto' : 'overflow-hidden p-4'
                      }`}
                    >
                      {widgetBody(w.id)}
                    </div>
                  </Card>
                </div>
              )
            })}
          </ResponsiveGridLayout>
        )}
      </div>

      <WidgetPanel
        open={panelOpen}
        hidden={hidden}
        onToggle={toggleWidget}
        onClose={() => setPanelOpen(false)}
        onReset={resetLayout}
      />

      <DetailModal dimension={detail} range={range} onClose={() => setDetail(null)} />
    </div>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DateRangeField,
  EmptyState,
  Icons,
  Modal,
  Skeleton,
  Textarea,
  useToast,
  type DateRange,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import type { DetailDimension, SalesDashboardData } from '@/lib/site/salesDashboard'
import type { DashboardOverview } from '@/lib/site/dashboardOverview'
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
import {
  SalesPerHourChart,
  SalesCountPerDayChart,
  TenderMixChart,
  TurnoverPerDayChart,
} from './Charts'
import { RankedTable, TABLE_CONFIG } from './RankedTable'
import { ExceptionsTable } from './ExceptionsTable'
import {
  AttentionList,
  CashPositionPanel,
  PipelinePanel,
  ReorderTable,
  JobStat,
  JobSplit,
} from './OverviewWidgets'
import { widgetBody as bodyFor, widgetNote as noteFor } from './WidgetBody'
import { WidgetPanel } from './WidgetPanel'
import { DetailModal } from './DetailModal'
import { SecondaryStrip } from './SecondaryStrip'

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
const SCROLLS: WidgetId[] = [
  'topProducts',
  'topDepartments',
  'topCashiers',
  'voidsAndReturns',
  'attention',
  'cashPosition',
  'reorder',
  'jobsByStatus',
  'jobsByTechnician',
]

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
  exceptions: null,
  hasData: false,
}

/**
 * What an as-at widget shows when it has no data to show.
 *
 * Three different situations, and they must not look alike: the fetch failed,
 * the fetch succeeded but the user is not entitled to this section, or it has
 * not arrived yet. Only the middle one is permanent, and saying "not available"
 * for a request still in flight is how a dashboard trains people to distrust
 * it.
 */

/** This month to date — the period a store owner checks most. */
function thisMonth(): DateRange {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
}

export function SalesDashboard({
  visibleWidgets,
}: {
  /**
   * The widgets this role could see. An affordance, not a boundary — the
   * endpoints gate the data, and this only stops the screen offering a box
   * that could never fill. See the comment in page.tsx.
   */
  visibleWidgets: readonly WidgetId[]
}) {
  const toast = useToast()
  const [range, setRange] = useState<DateRange>(thisMonth)
  const [data, setData] = useState<SalesDashboardData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The as-at-now half. Separate state because it is a separate endpoint on a
  // separate cadence — it is fetched once and does NOT move with the range.
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [editing, setEditing] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  /** The captured layout, shown for copying. Null when the dialog is closed. */
  const [layoutDump, setLayoutDump] = useState<string | null>(null)
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

  /*
   * The overview, fetched once on mount and on an explicit refresh.
   *
   * Deliberately NOT keyed to the range: none of these figures move with it, so
   * refetching them on every slider nudge would be work done to produce the
   * same answer. It runs in parallel with the sales fetch above rather than
   * after it, so the page costs the slower of the two and not the sum.
   */
  const loadOverview = useCallback(() => {
    setRefreshing(true)
    setOverviewError(null)
    fetch('/api/dashboard/overview')
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) {
          setOverviewError(body.error ?? 'Failed to load the overview.')
          setOverview(null)
        } else {
          setOverview(body as DashboardOverview)
        }
      })
      .catch(() => {
        setOverviewError('Could not reach the server.')
        setOverview(null)
      })
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(loadOverview, [loadOverview])

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

  /*
   * Copy the current arrangement out, so it can become the DEFAULT arrangement.
   *
   * A developer affordance, and deliberately a visible one rather than a
   * console incantation: tuning the default layout means dragging it until it
   * looks right and then transcribing twenty x/y/w/h quadruples into
   * widgets.ts, and reading those off a screen is how a transcription error
   * gets in. Edit mode only — it is not something a shop needs.
   *
   * The output is already shaped like the registry, hidden list included, so
   * pasting it into WIDGETS is mechanical.
   */
  const copyLayout = useCallback(() => {
    const byId = new Map(layout.map((l) => [l.i, l]))
    const lines = WIDGETS.map((w) => {
      const l = byId.get(w.id)
      if (!l) return `  // ${w.id}: no saved position`
      return `  ${w.id}: { x: ${l.x}, y: ${l.y}, w: ${l.w}, h: ${l.h} },`
    })
    const text = [
      '// Captured from a live dashboard. Paste into WIDGETS in widgets.ts,',
      '// and remember to bump STORAGE_KEY so existing users pick it up.',
      `// hidden: [${hidden.map((h) => `'${h}'`).join(', ')}]`,
      '{',
      ...lines,
      '}',
    ].join('\n')

    // Shown either way. The clipboard is refused on an insecure origin, by
    // policy, and whenever the document is not focused — and a copy button
    // whose only failure story is "go read localStorage" is a copy button that
    // strands you. The dialog is the reliable path; the clipboard is the
    // convenience on top of it.
    setLayoutDump(text)
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success('Layout copied to the clipboard.'))
      .catch(() => {
        /* The dialog is already up — no toast, it would only be noise. */
      })
  }, [layout, hidden, toast])

  const resetLayout = useCallback(() => {
    const fresh = defaultLayout()
    setLayout(fresh)
    setHidden([])
    savePrefs({ layout: fresh, hidden: [] })
  }, [])

  /* Hidden by the user, or never available to this role — the grid cannot tell
     the difference and does not need to. */
  const shown = useCallback(
    (id: WidgetId) => visibleWidgets.includes(id) && !hidden.includes(id),
    [visibleWidgets, hidden],
  )

  const visibleLayout = useMemo(
    () => layout.filter((l) => shown(l.i as WidgetId)),
    [layout, shown],
  )

  /* Both widget bodies and the phone's stacked view read ONE implementation —
     see WidgetBody.tsx for why that matters more than the stacking does. */
  function widgetBody(id: WidgetId) {
    return bodyFor(id, { data, overview, overviewError })
  }

  function widgetNote(id: WidgetId): string | null {
    return noteFor(id, overview)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Chrome: roomy, because this is the part that gets clicked. */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-border bg-surface px-4 py-3.5">
        <div className="flex items-end gap-3">
          {/* "Sales period", not "Period" — half this screen ignores it. One
              word, and it stops the toolbar claiming the whole dashboard. */}
          <DateRangeField value={range} onChange={setRange} label="Sales period" />
          <Button variant="ghost" onClick={() => setRange(thisMonth())}>
            <Icons.Calendar size={15} />
            This month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-muted">Loading…</span>}
          {/* The as-at half has no date to reset, so it gets its own refresh —
              it is fetched once on mount and would otherwise go stale on a
              dashboard left open all day. */}
          <Button
            variant="ghost"
            onClick={loadOverview}
            disabled={refreshing}
            aria-label="Refresh the as-at figures"
            title="Refresh debtors, cash, stock and open tills"
          >
            <Icons.Refresh size={15} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          {editing && (
            <>
              <Button variant="secondary" onClick={() => setPanelOpen(true)}>
                <Icons.LayoutGrid size={15} />
                Widgets
              </Button>
              {/* Copies this arrangement out so it can be made the default for
                  everyone. See copyLayout — a dev affordance, edit mode only. */}
              <Button
                variant="ghost"
                onClick={copyLayout}
                title="Copy this arrangement, to make it the default for everyone"
              >
                <Icons.Copy size={15} />
                Copy layout
              </Button>
            </>
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

      {/* Separate from the sales banner: the two halves fail independently, and
          "the ageing did not load" must not be read as "the sales did not". */}
      {overviewError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning bg-warning-soft px-4 py-3">
          <p className="text-sm text-warning-ink">
            <span className="font-semibold">Couldn&apos;t load the current figures.</span>{' '}
            {overviewError} The sales figures below are unaffected.
          </p>
          <Button variant="secondary" onClick={loadOverview} disabled={refreshing}>
            <Icons.Refresh size={15} />
            Try again
          </Button>
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
            {WIDGETS.filter((w) => shown(w.id)).map((w) => {
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

              /*
               * The rates band, like the KPI tiles, brings its own chrome and
               * takes no CardHeader.
               *
               * A header would defeat the widget: the band's whole job is to sit
               * tight under the tiles as a continuation of the headline block,
               * and a title bar reading "Rates" above four cells that are
               * already labelled would both repeat itself and cost the row the
               * ~40px that lets it stay two grid rows tall.
               */
              if (w.id === 'rates') {
                return (
                  <div
                    key={w.id}
                    className={
                      editing ? 'widget-drag cursor-move rounded-card ring-1 ring-brand' : ''
                    }
                  >
                    <SecondaryStrip data={data} loading={loading} />
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
                      /* No brand rule down the left edge. The rule marks one
                         card as the subject of a screen; the dashboard is a
                         grid of a dozen equal widgets, so drawing it on every
                         one of them marked nothing and just striped the page
                         blue. The cards keep their plain border. */
                      tone="default"
                      className={editing ? 'widget-drag cursor-move select-none' : ''}
                      title={
                        <span className="flex items-center gap-1.5">
                          {editing && <Icons.ArrowLeftRight size={14} className="text-brand" />}
                          {w.title}
                        </span>
                      }
                      action={
                        editing ? undefined : (
                          <span className="flex items-center gap-2">
                            {/* Which location a reorder suggestion is for. Only
                                shown when there is more than one, because on a
                                single-location site it is noise. */}
                            {widgetNote(w.id) && (
                              <span className="text-xs text-muted">{widgetNote(w.id)}</span>
                            )}
                            {/* The scope marker. Without it, a figure that
                                ignores the toolbar sitting silently under one
                                is read as belonging to it. */}
                            {w.scope === 'asAt' && overview && (
                              <Badge tone="neutral">
                                <span title={`As at ${overview.asAt}`}>As at today</span>
                              </Badge>
                            )}
                            {dimension && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDetail(dimension)}
                              >
                                View more
                                <Icons.ArrowRight size={14} />
                              </Button>
                            )}
                          </span>
                        )
                      }
                    />
                    <div
                      /* A flex COLUMN, not a plain block. A chart body that
                         carries a takeaway line under it stacks two children —
                         the chart taking what is left, the sentence keeping its
                         own height — and `flex-1` on that chart only resolves
                         against a flex parent with a definite height. As a
                         block it measured the chart at full height and drew the
                         sentence straight over the x-axis labels. */
                      className={`flex min-h-0 flex-1 flex-col ${
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
        visible={visibleWidgets}
        onToggle={toggleWidget}
        onClose={() => setPanelOpen(false)}
        onReset={resetLayout}
      />

      {/* The captured arrangement, selectable. See copyLayout for why this is
          shown rather than relying on the clipboard alone. */}
      <Modal
        open={layoutDump !== null}
        onClose={() => setLayoutDump(null)}
        title="This arrangement"
        description="Paste this into widgets.ts to make it the default for everyone."
        size="lg"
        footer={
          <Button variant="primary" onClick={() => setLayoutDump(null)}>
            Done
          </Button>
        }
      >
        <Textarea
          readOnly
          value={layoutDump ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          rows={16}
          spellCheck={false}
          className="resize-none font-mono text-xs"
        />
      </Modal>

      <DetailModal dimension={detail} range={range} onClose={() => setDetail(null)} />
    </div>
  )
}

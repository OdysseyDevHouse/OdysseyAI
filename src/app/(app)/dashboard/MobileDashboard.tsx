'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  CardHeader,
  DateRangeField,
  EmptyState,
  Icons,
  Skeleton,
  type DateRange,
} from '@/components/ui'
import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import type { DashboardOverview } from '@/lib/site/dashboardOverview'
import { WIDGETS, type KpiId, type WidgetId } from './widgets'
import { KPI_BY_ID, KpiTile } from './KpiTile'
import { widgetBody, widgetNote } from './WidgetBody'

/**
 * The dashboard, on a phone.
 *
 * ── WHY THIS EXISTS INSTEAD OF A BREAKPOINT ON THE GRID ─────────────────────
 *
 * The desktop dashboard is a `react-grid-layout` canvas the user arranges
 * themselves: sixty columns, one breakpoint, positions saved per browser. That
 * is right for a mouse and unusable on a phone, and not marginally so —
 * measured at 390px it gives the narrowest widget ONE pixel, pushes six widgets
 * off the side of the screen and overflows horizontally.
 *
 * Adding a phone breakpoint to the grid would be worse than it sounds. The
 * layout is a saved user preference, so a phone re-flowing it would silently
 * rewrite the arrangement that person built at their desk — and drag-to-resize
 * on a touch screen fights the scroll it sits inside. So the phone does not get
 * a narrower grid. It gets no grid: one column, in registry order, no drag.
 *
 * ── WHAT IT DELIBERATELY SHARES ─────────────────────────────────────────────
 *
 * Everything that decides a NUMBER. The same two endpoints, the same widget
 * registry, and — via WidgetBody — the same rendering for every widget body.
 * Only the arrangement differs, which is the only thing that should: two copies
 * of the widget switch would eventually be two answers to what the shop took,
 * and nobody would know which screen was lying.
 */

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

/** This month, which is what somebody opening the app on the floor means. */
function thisMonth(): DateRange {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(first), to: iso(now) }
}

export function MobileDashboard({ visibleWidgets }: { visibleWidgets: WidgetId[] }) {
  const [range, setRange] = useState<DateRange>(thisMonth)
  const [data, setData] = useState<SalesDashboardData>(EMPTY)
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /* The same id guard the desktop uses: a slow response for a range the user
     has already moved on from must not overwrite a newer one. */
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

  const shown = (id: WidgetId) => visibleWidgets.includes(id)

  /* KPIs first and separately: six small figures that read as a strip, not as
     six cards a screen tall each. Everything else follows in registry order,
     which is the order the desktop's default layout uses — so somebody who
     knows the desktop finds things where they expect them. */
  const kpiIds = WIDGETS.filter((w) => KPI_BY_ID.has(w.id as KpiId) && shown(w.id)).map(
    (w) => w.id as KpiId,
  )
  const panelIds = WIDGETS.filter((w) => !KPI_BY_ID.has(w.id as KpiId) && shown(w.id)).map(
    (w) => w.id,
  )

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Chrome gets room even here — it is the part that gets tapped. */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <DateRangeField label="Sales period" value={range} onChange={setRange} />
        <Button
          variant="ghost"
          size="touch"
          onClick={loadOverview}
          disabled={refreshing}
          className="w-full"
        >
          <Icons.Refresh size={16} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <Card>
          <EmptyState
            icon={<Icons.StatusWarning size={22} />}
            title="Couldn't load the figures"
            hint={error}
          />
        </Card>
      )}

      {/* Two across: a KPI is one number and a sparkline, and at 390px two of
          them still clear the 14px floor for readable type. One across would
          make six taps of scrolling out of a glance. */}
      <div className="grid grid-cols-2 gap-3">
        {kpiIds.map((id) => {
          const def = KPI_BY_ID.get(id)
          if (!def) return null
          return (
            <KpiTile
              key={id}
              def={def}
              kpis={data.kpis}
              compareKpis={data.compareKpis}
              compareLabel={data.compareLabel}
              perDay={data.perDay}
              loading={loading}
            />
          )
        })}
      </div>

      {panelIds.map((id) => {
        const widget = WIDGETS.find((w) => w.id === id)
        if (!widget) return null
        const note = widgetNote(id, overview)
        return (
          <Card key={id}>
            <CardHeader title={widget.title} description={note ?? undefined} />
            {/* No fixed height, unlike the grid: a card sized to its content is
                the whole reason this scrolls properly. A table that would
                overflow scrolls inside its own box rather than the page. */}
            <div className="overflow-x-auto">
              {loading && !overview ? (
                <div className="flex flex-col gap-2 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : (
                widgetBody(id, { data, overview, overviewError })
              )}
            </div>
          </Card>
        )
      })}

      {!loading && !error && kpiIds.length === 0 && panelIds.length === 0 && (
        <Card>
          <EmptyState
            icon={<Icons.Info size={22} />}
            title="Nothing to show"
            hint="Your role does not include any of the dashboard figures."
          />
        </Card>
      )}
    </div>
  )
}

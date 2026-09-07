'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, CardHeader, EmptyState, Icons, type DateRange } from '@/components/ui'
import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import type { DashboardOverview } from '@/lib/site/dashboardOverview'
import { defaultHidden, type WidgetId } from './widgets'
import { AttentionList } from './OverviewWidgets'
import { PhoneHero } from './PhoneHero'
import { PhoneKpiGrid } from './PhoneKpiGrid'
import { PhonePerHour } from './PhonePerHour'
import { PhoneRankings } from './PhoneRankings'
import { PhonePeriod, periodLabel, rangeFor, type PeriodKey } from './PhonePeriod'

/**
 * The dashboard, on a phone.
 *
 * ── WHY THIS IS A COMPOSITION AND NOT THE DESKTOP STACKED ───────────────────
 *
 * It used to be the widget registry in one column: every visible panel, in
 * registry order, each in its own card. That was the right first move — it
 * could not disagree with the desktop, because it WAS the desktop — but it
 * produced a screen fourteen cards long whose first answer to "how are we
 * trading" was somewhere around the fourth scroll.
 *
 * A phone dashboard is read standing up, in a few seconds, usually to settle
 * one question. So the order here is editorial rather than registry: the
 * headline figure, then the figures that qualify it, then when the shop was
 * busy, then what needs doing, then who is selling. Each is a section rather
 * than a card with a title, because a stack of fourteen titled cards is a
 * filing cabinet and this is meant to be a page.
 *
 * ── WHAT IS STILL SHARED, AND IT IS EVERYTHING THAT MATTERS ─────────────────
 *
 * The same two endpoints, the same `KPI_DEFS`, the same `insights.ts`, the same
 * charts, the same `AttentionList`, the same detail modal. Nothing here decides
 * a number. That was the original file's rule and it survives intact: two
 * copies of the widget switch would eventually be two answers to what the shop
 * took, and nobody would know which screen was lying.
 *
 * What is NOT shared any more is the arrangement and the selection — which is
 * the only thing that should differ, and is the whole reason this file exists.
 *
 * ── HOW A SECTION IS STILL SWITCHED OFF ─────────────────────────────────────
 *
 * Each section names the widget it is made of, and asks the same two questions
 * the stacked version did: may this user see it, and does the DEFAULT layout
 * hide it. So a figure switched off for a role stays off on the phone, and the
 * two screens still open on the same set of numbers. What the phone ignores is
 * this browser's saved ARRANGEMENT, because there is no grid here to arrange.
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
    itemCount: 0,
  },
  compareKpis: null,
  compareLabel: 'vs last month',
  compareShort: 'last month',
  perHour: [],
  perDay: [],
  tenderTypes: [],
  topProducts: [],
  topDepartments: [],
  topCashiers: [],
  exceptions: null,
  hasData: false,
}

export function MobileDashboard({ visibleWidgets }: { visibleWidgets: WidgetId[] }) {
  /* This month, which is what somebody opening the app on the floor means. */
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [range, setRange] = useState<DateRange>(() => rangeFor('month'))

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

  const offByDefault = defaultHidden()
  const shown = (id: WidgetId) => visibleWidgets.includes(id) && !offByDefault.includes(id)

  /* Widget id to ranking dimension, in reading order. Products first because
     it is the list somebody opens this card for. */
  const RANKINGS = [
    { widget: 'topProducts', dimension: 'products' },
    { widget: 'topDepartments', dimension: 'departments' },
    { widget: 'topCashiers', dimension: 'cashiers' },
  ] as const
  const availableRankings = RANKINGS.filter((r) => shown(r.widget)).map((r) => r.dimension)

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* The period is the one control on the screen, and everything below it
          answers to it — so it sits at the top and stays there while the
          figures under it scroll. */}
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 border-b border-border bg-canvas px-4 py-3">
        <PhonePeriod
          period={period}
          range={range}
          onChange={(nextPeriod, nextRange) => {
            setPeriod(nextPeriod)
            setRange(nextRange)
          }}
        />
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

      {shown('kpis') && (
        <PhoneHero
          kpis={data.kpis}
          compareKpis={data.compareKpis}
          compareShort={data.compareShort}
          perDay={shown('perDay') ? data.perDay : []}
          periodLabel={periodLabel(period, range)}
          loading={loading}
        />
      )}

      {shown('kpis') && <PhoneKpiGrid data={data} loading={loading} />}

      {shown('perHour') && <PhonePerHour data={data} loading={loading} />}

      {/* Second, not last: it is the only section on the screen that asks the
          reader to DO something, and a list of jobs under a ranking of products
          is a list nobody reaches. */}
      {shown('attention') && (
        <Card>
          {/* Refresh lives HERE rather than beside the period, which is where it
              started. It reloads the overview and nothing else — the sales
              figures already refetch when the period changes — so on the period
              bar it was a button that appeared to refresh the screen while
              refreshing one card of it. It also cost the fifth segment about
              fifty pixels, which is what clipped "Custom". */}
          <CardHeader
            title="Needs attention"
            description="As at today"
            action={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Check again"
                onClick={loadOverview}
                disabled={refreshing}
              >
                <Icons.Refresh size={16} />
              </Button>
            }
          />
          {overview ? (
            <AttentionList items={overview.attention} />
          ) : (
            <EmptyState
              icon={<Icons.Info size={22} />}
              title={overviewError ? "Couldn't load this" : 'Loading…'}
              hint={overviewError ?? 'Checking accounts, shelves and tills.'}
            />
          )}
        </Card>
      )}

      <PhoneRankings
        products={data.topProducts}
        departments={data.topDepartments}
        cashiers={data.topCashiers}
        available={[...availableRankings]}
        range={range}
        loading={loading}
      />

      {!loading && !error && !shown('kpis') && !shown('perHour') && !shown('attention') && availableRankings.length === 0 && (
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

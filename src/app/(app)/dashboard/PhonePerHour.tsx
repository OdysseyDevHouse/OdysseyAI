'use client'

import { MiniStat, Skeleton } from '@/components/ui'
import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import { money, count } from './format'
import { hour12, secondaryStats } from './insights'
import { SalesPerHourChart } from './Charts'

/**
 * When the shop is busy.
 *
 * The chart is the desktop's own, unchanged — it already plots an AVERAGE
 * trading day rather than the sum across the period, which is the only version
 * of this that means anything on a range longer than a day (see its
 * `tradingDays` prop).
 *
 * What the phone adds is the two figures underneath. On the desktop they are
 * read off the curve; at this width the curve shows the SHAPE well and the
 * peak's exact value not at all, so the two facts somebody actually takes from
 * it — when the rush is, and what an open hour is worth — are printed.
 */
export function PhonePerHour({
  data,
  loading,
}: {
  data: SalesDashboardData
  loading: boolean
}) {
  const stats = secondaryStats(data.perDay, data.perHour, data.kpis.saleCount)

  /* The busiest hour by takings, not by transaction count: a rush of small
     baskets and a quiet hour of big ones are different problems, and this card
     is about money. Reduced rather than sorted so an empty series gives null
     instead of an exception on [0]. */
  const busiest = data.perHour.reduce<null | (typeof data.perHour)[number]>(
    (best, h) => (best === null || h.turnover > best.turnover ? h : best),
    null,
  )

  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <div className="text-sm font-medium text-ink">Turnover per hour</div>
      <div className="text-xs text-muted">Average trading day</div>

      {loading ? (
        <Skeleton className="mt-3 h-40 w-full" />
      ) : (
        <>
          {/* A fixed height: the chart is a ResponsiveContainer, which measures
              its parent — inside an auto-height column it would measure zero and
              render nothing at all. */}
          <div className="mt-3 h-44">
            <SalesPerHourChart data={data.perHour} tradingDays={stats.tradingDays || 1} />
          </div>

          {busiest && busiest.turnover > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MiniStat
                label="Busiest hour"
                value={`${hour12(busiest.hour)} · ${money(busiest.turnover / (stats.tradingDays || 1))}`}
              />
              <MiniStat
                label="Turnover per hour"
                value={`${money(stats.turnoverPerHour)} · ${count(Math.round(stats.salesPerHour))} sales`}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

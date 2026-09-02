'use client'

import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import { money, count, decimal } from './format'
import { secondaryStats, plural } from './insights'

/**
 * The rate strip — the headline figures divided by the time they took.
 *
 * It sits directly under the KPI tiles and answers the question they raise. A
 * KPI says the shop turned over R1.2m; this says that was R33 548 a day across
 * 31 trading days, R2 796 in an average open hour, and 294 sales a day. Those
 * are the numbers a shop owner can actually do something with — they are
 * comparable against yesterday, against a target, and against what it costs to
 * keep the doors open, in a way that a monthly total never is.
 *
 * ONE widget, not four.
 *
 * Every KPI above it is its own widget, on the argument that a store which
 * never looks at items-per-sale should be able to hide that tile. These four
 * are different: they are one thought — the period broken down into rates — and
 * they only read correctly as a row, because each is a division of the same
 * turnover by a different unit of time. Split into four draggable widgets they
 * would be four unlabelled ratios scattered across a dashboard. So the strip
 * moves, resizes and hides as a single band.
 *
 * It costs nothing to add: every figure comes out of `perDay` and `perHour`,
 * which are already on the wire for the charts. There is no second request
 * behind this row, and no chance of it disagreeing with the charts below it —
 * see insights.ts.
 */
export function SecondaryStrip({
  data,
  loading,
}: {
  data: SalesDashboardData
  loading?: boolean
}) {
  const stats = secondaryStats(data.perDay, data.perHour, data.kpis.saleCount)

  // Nothing traded: the strip would be four zeroes explaining themselves, under
  // an empty-state message that has already said it better.
  if (stats.tradingDays === 0) return null

  return (
    <div
      /* h-full so the band fills the grid cell it was given rather than sizing
         to its text and leaving a gap under itself — the widget below would
         otherwise appear to float away from the headline block. */
      className={`grid h-full grid-cols-2 overflow-hidden rounded-card border border-border bg-surface lg:grid-cols-4 ${
        loading ? 'opacity-40' : ''
      }`}
    >
      <Rate label="Total sales" value={count(stats.saleCount)} hint="finalised in the period" />
      <Rate
        label="Turnover per day"
        value={money(stats.turnoverPerDay)}
        hint={plural(stats.tradingDays, 'trading day')}
      />
      <Rate
        label="Turnover per hour"
        value={money(stats.turnoverPerHour)}
        hint={`${plural(stats.tradingHours, 'hour')} a day`}
      />
      <Rate
        label="Sales per day"
        value={decimal(stats.salesPerDay, 0)}
        hint={`${decimal(stats.salesPerHour)} an hour`}
      />
    </div>
  )
}

/**
 * One cell of the strip: label, figure, and what it was divided by.
 *
 * Label and value sit on ONE line, which is what separates this row from the
 * KPI tiles above it and is the whole reason it can be a single band rather
 * than a second row of cards. The KPI tiles are the headline and are stacked
 * and large; these are the working rates behind them and read as a list.
 *
 * The hint is not filler — it is the denominator. "R2 796 per hour" is an
 * unreadable figure until you know it means an average open hour of a twelve
 * hour day, and a rate whose divisor is invisible is a rate nobody can check.
 */
function Rate({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    /* Rules on the top and left of every cell, clipped away at the band's own
       edges by the container's `overflow-hidden` and a negative offset. This is
       the one divider scheme that survives BOTH grid shapes: at four columns it
       draws three vertical rules, and at two it draws one vertical and one
       horizontal, without either count being written down anywhere. */
    <div className="-ml-px -mt-px flex flex-wrap content-center items-baseline gap-x-2 gap-y-0.5 border-l border-t border-border px-4 py-3">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="numeric ml-auto text-base font-semibold text-ink">{value}</span>
      <span className="w-full text-xs text-muted lg:w-auto lg:basis-full">{hint}</span>
    </div>
  )
}

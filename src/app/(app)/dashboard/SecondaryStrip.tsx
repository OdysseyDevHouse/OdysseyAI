'use client'

import type { ReactNode } from 'react'
import { Icons, StatIcon } from '@/components/ui'
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

  /*
   * The sale count is the one figure here with a period to compare against —
   * the other three are rates, and the payload carries no trading-day count for
   * last month to divide them by. So it gets the comparison and they keep their
   * divisors, which is the more useful line for each of them anyway.
   *
   * This is also why the count sits at the head of the band rather than up in
   * the KPI row: it is the number every rate beside it is derived from.
   */
  const base = data.compareKpis?.saleCount ?? null
  const salesDelta =
    base === null || base === 0
      ? null
      : ((stats.saleCount - base) / base) * 100

  return (
    <div
      /* h-full so the band fills the grid cell it was given rather than sizing
         to its text and leaving a gap under itself — the widget below would
         otherwise appear to float away from the headline block. */
      className={`grid h-full grid-cols-2 overflow-hidden rounded-card border border-border bg-surface lg:grid-cols-4 ${
        loading ? 'opacity-40' : ''
      }`}
    >
      <Rate
        label="Total sales"
        icon={<Icons.ShoppingCart size={16} />}
        value={count(stats.saleCount)}
        hint={
          salesDelta === null
            ? 'finalised in the period'
            : `${salesDelta >= 0 ? '+' : '-'}${Math.abs(salesDelta).toFixed(1)}%`
        }
        /* The only coloured hint in the band: it is the only one that is a
           verdict rather than a divisor. "31 trading days" is not good news. */
        tone={salesDelta === null ? 'flat' : salesDelta >= 0 ? 'up' : 'down'}
      />
      <Rate
        label="Turnover per day"
        icon={<Icons.BarChart size={16} />}
        value={money(stats.turnoverPerDay)}
        hint={plural(stats.tradingDays, 'trading day')}
      />
      <Rate
        label="Turnover per hour"
        icon={<Icons.Clock size={16} />}
        value={money(stats.turnoverPerHour)}
        hint={`${plural(stats.tradingHours, 'hour')} a day`}
      />
      <Rate
        label="Sales per day"
        icon={<Icons.Users size={16} />}
        value={decimal(stats.salesPerDay, 0)}
        hint={`${decimal(stats.salesPerHour)} an hour`}
      />
    </div>
  )
}

const HINT_TONE = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
} as const

/**
 * One cell of the strip: medallion, caption, figure and what it was divided by.
 *
 * The same shape as a headline cell above it — icon, caption, figure — because
 * the two bands are one block and a reader should not have to switch reading
 * habits halfway down it. What separates them is weight: the headline figure is
 * text-2xl and stacked, this one is text-base with its divisor beside it, so
 * the top band reads as the answer and this one as the working.
 *
 * The hint is not filler — it is the denominator. "R2 796 per hour" is an
 * unreadable figure until you know it means an average open hour of a twelve
 * hour day, and a rate whose divisor is invisible is a rate nobody can check.
 * It sits against the figure rather than at the far edge, because a divisor
 * separated from its numerator by a column of white is read as a fourth
 * unrelated fact.
 */
function Rate({
  label,
  icon,
  value,
  hint,
  tone = 'flat',
}: {
  label: string
  icon: ReactNode
  value: string
  hint: string
  tone?: keyof typeof HINT_TONE
}) {
  return (
    /* Rules on the top and left of every cell, clipped away at the band's own
       edges by the container's `overflow-hidden` and a negative offset. This is
       the one divider scheme that survives BOTH grid shapes: at four columns it
       draws three vertical rules, and at two it draws one vertical and one
       horizontal, without either count being written down anywhere. */
    <div className="-ml-px -mt-px flex items-center gap-3 overflow-hidden border-l border-t border-border px-4 py-3">
      <StatIcon>{icon}</StatIcon>

      <div className="min-w-0 flex-1">
        {/* The same warm caption as the headline band above, so the two read as
            one block rather than as a strip and an unrelated table. */}
        <div className="truncate text-xs font-medium text-stat-label">{label}</div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="numeric text-base font-semibold text-ink">{value}</span>
          <span className={`truncate text-xs ${HINT_TONE[tone]}`} title={hint}>
            {hint}
          </span>
        </div>
      </div>
    </div>
  )
}

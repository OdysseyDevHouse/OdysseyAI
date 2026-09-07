'use client'

import type { ReactNode } from 'react'
import { Icons, Skeleton, StatIcon } from '@/components/ui'
import type { SalesDashboardData } from '@/lib/site/salesDashboard'
import { money, count, decimal } from './format'
import { plural, secondaryStats } from './insights'
import { KPI_BY_ID, NOTE_TONE, type Note } from './KpiStrip'

/**
 * The figures under the headline, two across.
 *
 * ── WHY TWO COLUMNS AND NOT ONE ─────────────────────────────────────────────
 *
 * Six figures in a single column is six screens of scrolling to see what the
 * desktop shows in a band, and a phone dashboard that cannot be taken in
 * without scrolling has lost the only thing it was for. Two across at 390px
 * leaves each cell about 170px — enough for a medallion, a caption, a figure at
 * 20px and a note, all above the 14px floor.
 *
 * ── WHERE THESE COME FROM ───────────────────────────────────────────────────
 *
 * Four are the desktop's own KPI cells, read out of KPI_BY_ID — same label,
 * same icon, same figure, same note, because a phone printing a different
 * comparison sentence for gross profit than the desktop does is two answers to
 * one question.
 *
 * The turnover pair is deliberately absent: the hero above owns it, and
 * repeating it here would put the screen's loudest number in a small cell
 * fifty pixels below itself.
 *
 * The last two are rates rather than KPIs — the sale count and what the shop
 * takes in a trading day, from `secondaryStats`. On the desktop they live in
 * their own band; there is no room for a second band here, and they are the two
 * of that band a phone reader actually uses. See SecondaryStrip for why the
 * divisor is TRADING days rather than calendar ones.
 */

/** The four desktop cells this grid borrows, in the order they read best. */
const BORROWED = ['grossProfit', 'grossProfitPct', 'avgSaleValue', 'avgItemsPerSale'] as const

export function PhoneKpiGrid({
  data,
  loading,
}: {
  data: SalesDashboardData
  loading: boolean
}) {
  const ctx = {
    kpis: data.kpis,
    compare: data.compareKpis,
    compareShort: data.compareShort,
  }
  const stats = secondaryStats(data.perDay, data.perHour, data.kpis.saleCount)

  /* The sale count is the one rate with a period to compare against — the
     payload carries no trading-day count for last month to divide the others
     by. Same reasoning as the desktop band. */
  const base = data.compareKpis?.saleCount ?? null
  const salesNote: Note =
    base === null || base === 0
      ? { text: 'No comparison data', tone: 'flat' }
      : (() => {
          const change = ((stats.saleCount - base) / base) * 100
          if (Math.abs(change) < 0.05) return { text: `Level on ${data.compareShort}`, tone: 'flat' }
          return {
            text: `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}% on ${data.compareShort}`,
            tone: change > 0 ? 'up' : 'down',
          }
        })()

  return (
    <div className="grid grid-cols-2 gap-3">
      {BORROWED.map((id) => {
        const def = KPI_BY_ID.get(id)
        if (!def) return null
        const note = def.note(ctx)
        return (
          <Cell
            key={id}
            icon={def.icon}
            label={def.label}
            value={def.value(data.kpis)}
            note={note}
            loading={loading}
          />
        )
      })}

      <Cell
        icon={<Icons.Receipt size={16} />}
        label="Total sales"
        value={count(stats.saleCount)}
        note={salesNote}
        loading={loading}
      />
      <Cell
        icon={<Icons.Calendar size={16} />}
        label="Turnover per day"
        value={money(stats.turnoverPerDay)}
        note={{
          text: stats.tradingDays ? `${plural(stats.tradingDays, 'trading day')}` : 'No trading days',
          tone: 'flat',
        }}
        loading={loading}
      />
    </div>
  )
}

/**
 * One cell.
 *
 * Three lines and a medallion, exactly as the desktop's is — caption, figure,
 * and the one thing worth saying about it. The note is not padding: a number
 * on its own is unreadable, and "R645 840" only becomes a statement once
 * something beside it says whether that is better than last month.
 */
function Cell({
  icon,
  label,
  value,
  note,
  loading,
}: {
  icon: ReactNode
  label: string
  value: string
  note: Note
  loading: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <StatIcon size="sm">{icon}</StatIcon>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
      </div>

      {loading ? (
        <>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </>
      ) : (
        <>
          {/* 20px rather than the desktop's 24: the hero above is the headline,
              and a grid of six 24px figures under a 36px one is two headlines
              arguing. */}
          <div className="numeric truncate text-xl font-semibold text-ink">{value}</div>
          <div className={`truncate text-xs ${NOTE_TONE[note.tone]}`}>{note.text}</div>
        </>
      )}
    </div>
  )
}

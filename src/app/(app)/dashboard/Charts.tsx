'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartGlow, ChartTooltip, EmptyState, Icons, useChartColors } from '@/components/ui'
import type { DayBucket, HourBucket, TenderBucket } from '@/lib/site/salesDashboard'
import { money, moneyShort, count, percent, dayLabel, hourLabel } from './format'

/**
 * The dashboard's charts.
 *
 * All of them read colour from `useChartColors()` and never name one directly —
 * that is what keeps them correct in dark mode and restyleable from
 * globals.css. Axes are formatted with `moneyShort` and tooltips with the full
 * `money`, so the scale stays readable while the number under the cursor is
 * exact.
 */

/** Shared axis/grid setup, so the two line charts cannot drift apart. */
function axisProps(colors: ReturnType<typeof useChartColors>) {
  return {
    stroke: colors.axis,
    tick: { fontSize: 11, fill: colors.axis },
    tickLine: false,
    axisLine: { stroke: colors.grid },
  }
}

/**
 * Density past which the per-reading markers are dropped.
 *
 * A marker at every point is the whole look, but only while the points are far
 * enough apart to be separate objects. A year of daily readings at this width
 * puts them a few pixels apart, where they stop reading as data and start
 * reading as a fat, lumpy line — so beyond this the line carries it alone.
 */
const MAX_DOTS = 40

/**
 * One line chart, used for both the per-day and per-hour series.
 *
 * They differ only in their labels and tick density, and having written them
 * twice in the original it is clear they should have been one component: every
 * styling fix had to be made in both places.
 *
 * Drawn as a lit line — a marker at each reading, a halo of the line's own
 * colour underneath — rather than as a filled area. The fill was decoration:
 * with a single series there is nothing to compare the shaded mass against, and
 * on the dark surface the gradient muddied the bottom of the card. The markers
 * do earn their place: they show where a reading actually is, so a flat stretch
 * reads as several equal days rather than as one long segment.
 */
function TurnoverLine({
  rows,
  glowId,
  tickInterval,
  seriesName = 'Turnover',
  color,
  format,
  axisFormat,
}: {
  rows: { label: string; turnover: number }[]
  glowId: string
  tickInterval?: number
  /** What the tooltip calls the series. */
  seriesName?: string
  /** Defaults to brand. Pass one from useChartColors, never a literal. */
  color?: string
  /** Tooltip formatter. Defaults to money. */
  format?: (value: number) => string
  /** Y-axis formatter. Defaults to the short money form. */
  axisFormat?: (value: number) => string
}) {
  const colors = useChartColors()
  const axis = axisProps(colors)
  // The series carries a `turnover` key whatever it measures — the shape is
  // the chart's, not the caller's, so a count rides in the same field rather
  // than duplicating this component for a different key name.
  const stroke = color ?? colors.brand
  const tooltipFormat = format ?? ((v: number) => money(v))
  const yFormat = axisFormat ?? ((v: number) => moneyShort(v))

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={200}>
      <LineChart data={rows} margin={{ top: 10, right: 14, bottom: 4, left: 4 }}>
        <defs>
          <ChartGlow id={glowId} strength={colors.glow} />
        </defs>
        {/* Horizontal rules only. Vertical gridlines on a time series add ink
            without adding an answer — the x labels already mark the columns. */}
        <CartesianGrid vertical={false} stroke={colors.grid} />
        <XAxis dataKey="label" {...axis} interval={tickInterval} minTickGap={8} />
        <YAxis {...axis} width={64} tickFormatter={(v) => yFormat(Number(v))} />
        <Tooltip
          cursor={{ stroke: colors.grid }}
          content={(p) => (
            <ChartTooltip
              active={p.active}
              payload={p.payload}
              label={p.label}
              format={(v) => tooltipFormat(Number(v))}
            />
          )}
        />
        <Line
          type="monotone"
          dataKey="turnover"
          name={seriesName}
          stroke={stroke}
          strokeWidth={2}
          filter={`url(#${glowId})`}
          /* The markers glow with the line rather than sitting flat on top of
             it — the same filter, so the two can never drift apart. */
          dot={
            rows.length <= MAX_DOTS
              ? { r: 2.5, fill: stroke, stroke: 'none', filter: `url(#${glowId})` }
              : false
          }
          activeDot={{ r: 4.5, stroke: colors.surface, strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function TurnoverPerDayChart({ data }: { data: DayBucket[] }) {
  if (!data.some((d) => d.turnover !== 0)) {
    return (
      <EmptyState
        icon={<Icons.Calendar size={22} />}
        title="No sales in this period"
        hint="Try a wider date range, or check that sales have been finalised."
      />
    )
  }

  const rows = data.map((d) => ({ label: dayLabel(d.date), turnover: d.turnover }))
  // Thin the labels on a long range so they never overlap: about 12 ticks is
  // what fits a half-width card without rotating the text.
  const tickInterval = Math.max(0, Math.ceil(rows.length / 12) - 1)

  return <TurnoverLine rows={rows} glowId="perDayGlow" tickInterval={tickInterval} />
}

/**
 * How many baskets a day, as opposed to how much money.
 *
 * Its own chart rather than a second line on the turnover one: a dual axis
 * puts two unrelated scales on one grid and invites the reader to see a
 * correlation in what is really just two lines drawn near each other. Turnover
 * and basket-count genuinely do diverge — a quiet day of big orders looks
 * nothing like a busy day of small ones — and that divergence is the whole
 * reason to plot the second series at all.
 */
export function SalesCountPerDayChart({ data }: { data: DayBucket[] }) {
  const colors = useChartColors()

  if (!data.some((d) => d.saleCount !== 0)) {
    return (
      <EmptyState
        icon={<Icons.Receipt size={22} />}
        title="No sales in this period"
        hint="Try a wider date range, or check that sales have been finalised."
      />
    )
  }

  // `turnover` is the chart's field name, not a claim about the units — see
  // TurnoverLine. The count rides in it so the two charts stay one component.
  const rows = data.map((d) => ({ label: dayLabel(d.date), turnover: d.saleCount }))
  const tickInterval = Math.max(0, Math.ceil(rows.length / 12) - 1)

  return (
    <TurnoverLine
      rows={rows}
      glowId="countPerDayGlow"
      tickInterval={tickInterval}
      seriesName="Sales"
      /* The fourth ramp colour, matching the `saleCount` KPI tile, so the two
         readings of the same figure are recognisably the same thing. */
      color={colors.series[3]}
      format={(v) => count(v)}
      axisFormat={(v) => count(v)}
    />
  )
}

export function SalesPerHourChart({ data }: { data: HourBucket[] }) {
  if (!data.some((d) => d.turnover !== 0)) {
    return (
      <EmptyState
        icon={<Icons.Clock size={22} />}
        title="No sales in this period"
        hint="Try a wider date range, or check that sales have been finalised."
      />
    )
  }

  const rows = data.map((d) => ({ label: hourLabel(d.hour), turnover: d.turnover }))
  // Every second hour — 24 labels do not fit, and a two-hourly scale is still
  // precise enough to see when the shop is busy.
  return <TurnoverLine rows={rows} glowId="perHourGlow" tickInterval={1} />
}

/**
 * Tender mix as a donut with the total in the middle and a share legend.
 *
 * A donut earns its place here only because the question is genuinely
 * "what share of takings" over a handful of categories. It would be the wrong
 * chart for anything with more slices or any comparison over time.
 */
export function TenderMixChart({ data }: { data: TenderBucket[] }) {
  const colors = useChartColors()
  const total = data.reduce((sum, d) => sum + d.amount, 0)

  // The donut's own box, measured, so its radii can be real pixels. Recharts 3
  // draws nothing from percentage radii here, and a hardcoded pixel size would
  // either overflow a small tile or float in a large one.
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(200)
  useEffect(() => {
    const node = boxRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      // The limiting dimension: a wide, short tile must not draw a donut
      // taller than it.
      setSize(Math.max(0, Math.min(width, height)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  if (data.length === 0 || total <= 0) {
    return (
      <EmptyState
        icon={<Icons.CreditCard size={22} />}
        title="No takings in this period"
        hint="Tenders appear once a sale has been finalised."
      />
    )
  }

  const rows = data.map((d, i) => ({
    ...d,
    share: (d.amount / total) * 100,
    color: colors.series[i % colors.series.length],
  }))

  return (
    <div className="flex h-full w-full flex-col items-center gap-3 sm:flex-row sm:gap-4">
      {/* min-w-0 lets this shrink beside the legend rather than pushing it off
          the card. The box measures fine — it was the Pie's percentage radii
          that drew nothing; see the note on innerRadius below. */}
      <div ref={boxRef} className="relative h-full min-h-[160px] w-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%" minHeight={160}>
          <PieChart>
            <Pie
              data={rows}
              dataKey="amount"
              nameKey="label"
              cx="50%"
              cy="50%"
              /* Percentages here ("62%") drew nothing at all in Recharts 3 —
                 every slice group measured 0×0 inside a correctly sized SVG.
                 Pixel radii are unambiguous, and deriving them from the
                 measured box keeps the donut proportional at any tile size. */
              innerRadius={Math.max(28, Math.min(size * 0.3, 90))}
              outerRadius={Math.max(44, Math.min(size * 0.45, 132))}
              paddingAngle={2}
              /* The card colour, so slices read as separated rather than as a
                 ring with grey seams drawn on it. */
              stroke={colors.surface}
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
            >
              {rows.map((r) => (
                <Cell key={r.key} fill={r.color} />
              ))}
            </Pie>
            <Tooltip
              content={(p) => (
                <ChartTooltip
                  active={p.active}
                  payload={p.payload}
                  format={(v) => money(Number(v))}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="numeric text-lg font-semibold leading-none text-ink">
            {money(total)}
          </span>
          <span className="mt-1 text-xs text-muted">Takings</span>
        </div>
      </div>

      <ul className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:min-w-[124px]">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-pill"
              style={{ background: r.color }}
              aria-hidden
            />
            <span className="truncate text-muted">{r.label}</span>
            <span className="numeric ml-auto font-semibold text-ink">{percent(r.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

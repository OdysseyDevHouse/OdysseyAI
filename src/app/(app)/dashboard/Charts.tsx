'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartGlow, ChartTooltip, EmptyState, Icons, useChartColors } from '@/components/ui'
import type { DayBucket, HourBucket, TenderBucket } from '@/lib/site/salesDashboard'
import { money, moneyShort, count, percent, dayLabel, hourLabel } from './format'
import { dailyAverage, hour12, isWeekend, peakHours } from './insights'

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
 * One line chart, used for both the per-day and per-hour series.
 *
 * They differ only in their labels and tick density, and having written them
 * twice in the original it is clear they should have been one component: every
 * styling fix had to be made in both places.
 *
 * Drawn as a bare lit line — a halo of the line's own colour underneath, and
 * NO marker at each reading. The fill was decoration: with a single series
 * there is nothing to compare the shaded mass against, and on the dark surface
 * the gradient muddied the bottom of the card.
 *
 * The per-reading dots went the same way. The argument for them was that they
 * show where a reading actually is, so a flat stretch reads as several equal
 * days rather than one long segment — but on a real month that flat stretch is
 * most of the chart, and the dots turned it into a dotted rule running across
 * the card. They drew the eye to the quiet days and away from the peaks, which
 * is exactly backwards. The value under the cursor is still exact, and the
 * `activeDot` still marks whichever reading is being read.
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
          /* No resting markers — see the note on this component. The hover
             marker stays: it is the one dot that answers a question, because
             the reader put it there. */
          dot={false}
          activeDot={{ r: 4.5, stroke: colors.surface, strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * Turnover per day, as BARS rather than a line.
 *
 * A day's takings is a magnitude, not a reading on a continuum: the shop took
 * R52 400 on Saturday and R31 100 on Sunday, and there is no meaningful value
 * "between" them the way there is between two points on a temperature curve. A
 * line implies that interpolation and a bar does not, which is the whole
 * argument — and the bars also make a single exceptional day pop out of the
 * row, where a line only bends around it.
 *
 * Two things ride on top, and both were the point of the change:
 *
 *   The WEEKEND SPLIT. A second colour on Saturdays and Sundays turns the
 *   weekly rhythm into something you see rather than something you count off
 *   the dates. It is a fill difference on one series, not two series — the bars
 *   are the same measure, cut by which day it fell on.
 *
 *   The AVERAGE RULE. A dashed line at the mean gives every bar something to be
 *   measured against; without it a reader has to hold thirty numbers in their
 *   head to know whether Tuesday was good. It is drawn over trading days only,
 *   so a closed public holiday does not quietly drag the bar everything is
 *   judged against down below where the shop actually trades.
 */
export function TurnoverPerDayChart({ data }: { data: DayBucket[] }) {
  const colors = useChartColors()
  const axis = axisProps(colors)

  if (!data.some((d) => d.turnover !== 0)) {
    return (
      <EmptyState
        icon={<Icons.Calendar size={22} />}
        title="No sales in this period"
        hint="Try a wider date range, or check that sales have been finalised."
      />
    )
  }

  const rows = data.map((d) => ({
    label: dayLabel(d.date),
    turnover: d.turnover,
    weekend: isWeekend(d.date),
  }))
  // Thin the labels on a long range so they never overlap: about 12 ticks is
  // what fits a half-width card without rotating the text.
  const tickInterval = Math.max(0, Math.ceil(rows.length / 12) - 1)
  const average = dailyAverage(data)

  /* Weekday is the deep first ramp entry; the weekend takes the sixth, a
     lighter cyan-blue of the same family. Two steps of one hue rather than two
     unrelated hues: the split is a cut of ONE measure, and giving the weekend a
     categorically different colour would claim it is a different series. */
  const weekdayFill = colors.series[0]
  const weekendFill = colors.series[5]

  return (
    <div className="flex h-full w-full flex-col">
      {/* The legend is chrome, drawn once in HTML rather than by Recharts — it
          has to say what the dashed rule means as well as what the two fills
          do, and Recharts' legend only knows about series. */}
      <div className="mb-1 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
        <LegendSwatch color={weekdayFill} label="Weekday" />
        <LegendSwatch color={weekendFill} label="Weekend" />
        <span className="flex items-center gap-1.5 text-muted">
          <svg width="18" height="2" aria-hidden className="shrink-0">
            <line
              x1="0"
              y1="1"
              x2="18"
              y2="1"
              stroke={colors.danger}
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
          </svg>
          Daily average {moneyShort(average)}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%" minHeight={180}>
          <BarChart data={rows} margin={{ top: 8, right: 14, bottom: 4, left: 4 }}>
            <CartesianGrid vertical={false} stroke={colors.grid} />
            <XAxis dataKey="label" {...axis} interval={tickInterval} minTickGap={8} />
            <YAxis {...axis} width={64} tickFormatter={(v) => moneyShort(Number(v))} />
            <Tooltip
              /* A soft column behind the hovered bar, not a vertical line: the
                 bar IS the mark here, so the cursor should light the whole
                 column rather than draw a rule through it. */
              cursor={{ fill: colors.grid, fillOpacity: 0.4 }}
              content={(p) => (
                <ChartTooltip
                  active={p.active}
                  payload={p.payload}
                  label={p.label}
                  format={(v) => money(Number(v))}
                />
              )}
            />
            {average > 0 && (
              <ReferenceLine
                y={average}
                stroke={colors.danger}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                /* Behind the bars: the rule is a benchmark, and a dashed line
                   painted over the data reads as a correction to it. */
                ifOverflow="extendDomain"
              />
            )}
            <Bar
              dataKey="turnover"
              name="Turnover"
              /* Rounded top corners only. The bar is anchored to the baseline —
                 rounding the bottom would lift it off its own zero and make a
                 small day look like it floats. */
              radius={[3, 3, 0, 0]}
              maxBarSize={38}
            >
              {rows.map((r, i) => (
                <Cell key={i} fill={r.weekend ? weekendFill : weekdayFill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/** One legend entry: a dot in the series colour, its name in muted ink. */
function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
        style={{ background: color }}
      />
      {label}
    </span>
  )
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

/**
 * The shape of a trading day: turnover by hour, as a filled area.
 *
 * A fill EARNS its place on this one where it did not on the per-day line. The
 * question here is "when is the shop busy", and the answer is a shape — where
 * the mass sits between opening and closing. The area draws that mass; a bare
 * line leaves the reader to imagine it. It is also the one chart in the app
 * whose x-axis is a genuine continuum: 10:30 is a real moment between the 10am
 * and 11am readings, which is exactly the interpolation an area asserts.
 *
 * The two peaks are labelled ON the chart rather than left to a tooltip. The
 * rush hours are the single fact a manager takes off this card — it is a
 * rostering decision — and a number you have to go hunting for with a mouse is
 * a number that does not get read.
 *
 * It plots an AVERAGE day, not the range's total: `perHour` sums every day in
 * the period, so across a month the raw figure is thirty days of 10am stacked
 * together, and "R157 000 at 10am" is not a sentence about any day the shop
 * traded. Dividing by trading days makes each reading a typical hour.
 */
export function SalesPerHourChart({
  data,
  tradingDays = 1,
}: {
  data: HourBucket[]
  /**
   * Days that actually traded, from `secondaryStats`. Defaults to 1, which
   * plots the raw sum — right for a single-day range and the honest fallback
   * for any caller that has not measured it.
   */
  tradingDays?: number
}) {
  const colors = useChartColors()
  const axis = axisProps(colors)

  if (!data.some((d) => d.turnover !== 0)) {
    return (
      <EmptyState
        icon={<Icons.Clock size={22} />}
        title="No sales in this period"
        hint="Try a wider date range, or check that sales have been finalised."
      />
    )
  }

  const days = Math.max(1, tradingDays)

  /* Trimmed to the hours the shop actually trades, plus one either side.
     A grocer open 7am–6pm was spending half the chart drawing a flat line
     along the closed hours, which squashed the part with the answer in it into
     the middle third. The padding hour keeps the curve landing on the axis
     rather than being cut off mid-slope. */
  const busy = data.filter((d) => d.turnover !== 0)
  const first = Math.max(0, Math.min(...busy.map((d) => d.hour)) - 1)
  const last = Math.min(23, Math.max(...busy.map((d) => d.hour)) + 1)

  const rows = data
    .filter((d) => d.hour >= first && d.hour <= last)
    .map((d) => ({ hour: d.hour, label: hour12(d.hour), turnover: d.turnover / days }))

  const peaks = peakHours(data)
  const peakHourSet = new Set(peaks.map((p) => p.hour))

  // Every second hour when the window is long enough to crowd; all of them on a
  // short one, where thinning would leave three labels under a whole chart.
  const tickInterval = rows.length > 14 ? 1 : 0

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={180}>
      {/* Room at the top for the peak callouts, which sit above their markers
          and would otherwise be clipped. The busiest hour lands exactly on the
          top of the plot area, so the callout needs its full height in the
          margin — a smaller value clipped the number on the tallest peak, which
          is the one reading the label exists for. */}
      <AreaChart data={rows} margin={{ top: 28, right: 16, bottom: 4, left: 4 }}>
        <defs>
          <ChartGlow id="perHourGlow" strength={colors.glow} />
          {/* The fill: the line's own colour fading out downward, so the mass
              reads as belonging to the curve rather than as a block under it. */}
          <linearGradient id="perHourFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.series[1]} stopOpacity={0.28} />
            <stop offset="100%" stopColor={colors.series[1]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={colors.grid} />
        <XAxis dataKey="label" {...axis} interval={tickInterval} minTickGap={8} />
        <YAxis {...axis} width={64} tickFormatter={(v) => moneyShort(Number(v))} />
        <Tooltip
          cursor={{ stroke: colors.grid }}
          content={(p) => (
            <ChartTooltip
              active={p.active}
              payload={p.payload}
              label={p.label}
              format={(v) => money(Number(v))}
            />
          )}
        />
        <Area
          type="monotone"
          dataKey="turnover"
          name="Turnover"
          /* The second ramp entry — a teal-green, so this card is instantly
             distinguishable from the blue bars beside it. The two answer
             different questions and should not look like one chart split in
             half. */
          stroke={colors.series[1]}
          strokeWidth={2}
          fill="url(#perHourFill)"
          filter="url(#perHourGlow)"
          /* A marker on the peak hours ONLY, each carrying its figure. A dot at
             every hour would be twelve numbers on a card that is making one
             point. */
          dot={(props) => <PeakDot {...props} peaks={peakHourSet} color={colors.series[1]} />}
          activeDot={{ r: 4.5, stroke: colors.surface, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/**
 * The marker drawn at a peak hour, with its takings written above it.
 *
 * Returns an empty <g> rather than null for every other hour: Recharts types
 * a custom `dot` as returning an element, and handing it null blanks the whole
 * series rather than the one dot.
 */
function PeakDot({
  cx,
  cy,
  payload,
  peaks,
  color,
}: {
  cx?: number
  cy?: number
  payload?: { hour: number; turnover: number }
  peaks: Set<number>
  color: string
}) {
  if (cx === undefined || cy === undefined || !payload || !peaks.has(payload.hour)) {
    return <g />
  }
  return (
    <g>
      <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
      <text
        x={cx}
        y={cy - 11}
        textAnchor="middle"
        /* The token, not a ramp colour: this is a LABEL, and text wearing the
           series colour competes with the mark it is labelling. */
        fill="var(--color-ink)"
        fontSize={11}
        fontWeight={600}
      >
        {moneyShort(payload.turnover)}
      </text>
    </g>
  )
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

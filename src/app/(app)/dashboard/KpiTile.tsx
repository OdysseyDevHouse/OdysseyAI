'use client'

import type { ReactNode } from 'react'
import type { DayBucket, SalesKpis } from '@/lib/site/salesDashboard'
import { Sparkline, useChartColors, Icons } from '@/components/ui'
import { money, count, percent, decimal } from './format'
import type { KpiId } from './widgets'

/**
 * The headline tiles.
 *
 * Each one answers "what is this number, is it better than last month, and
 * which way has it been moving" — value, delta, sparkline. That third part is
 * what stops a tile lying: R400k of turnover means something different when
 * it arrived steadily than when it all came in on one day.
 */

type SeriesKey = 'turnover' | 'count'

type KpiDef = {
  id: KpiId
  label: string
  /** Index into the chart ramp. Colour identifies a tile, it does not rank it. */
  tone: number
  icon: ReactNode
  value: (k: SalesKpis) => ReactNode
  /** The raw metric behind the comparison delta. */
  metric: (k: SalesKpis) => number
  series: SeriesKey
}

/*
 * Six tiles, one figure each.
 *
 * Turnover incl/excl and sales/items-per-sale were briefly paired onto shared
 * tiles to save room. They are back apart because a figure riding under another
 * one is second-class: it gets no comparison against last month, no trend line
 * of its own, and cannot be hidden by a store that never looks at it — which is
 * the whole point of every KPI being its own widget.
 *
 * The pairs still read together, because the layout keeps them side by side:
 * the two turnovers open the first row, and the second row is the shape of a
 * basket — how many, how big, how full.
 */
export const KPI_DEFS: KpiDef[] = [
  {
    id: 'turnoverIncl',
    label: 'Turnover incl',
    tone: 0,
    icon: <Icons.Money size={18} />,
    // "Turnover" alone was fine while this was the only one; with the excl
    // reading beside it, an unlabelled tile is the ambiguous one.
    value: (k) => money(k.turnoverIncl),
    metric: (k) => k.turnoverIncl,
    series: 'turnover',
  },
  {
    id: 'turnoverExcl',
    label: 'Turnover excl',
    tone: 1,
    // A second money glyph rather than the same one twice: the tiles are two
    // readings of one number, and identical icons would say they are the same
    // number.
    icon: <Icons.Coins size={18} />,
    value: (k) => money(k.turnoverExcl),
    metric: (k) => k.turnoverExcl,
    series: 'turnover',
  },
  {
    id: 'grossProfit',
    label: 'Gross profit',
    tone: 2,
    icon: <Icons.BarChart size={18} />,
    // The margin rides along in brackets rather than taking a tile of its own:
    // a GP value without its percentage invites the wrong conclusion, and the
    // two are never read apart.
    value: (k) => (
      <>
        {money(k.grossProfit)}
        <span className="ml-1.5 text-sm font-semibold text-muted">
          ({percent(k.grossProfitPct)})
        </span>
      </>
    ),
    metric: (k) => k.grossProfit,
    series: 'turnover',
  },
  {
    id: 'saleCount',
    label: 'Sales',
    tone: 3,
    icon: <Icons.Receipt size={18} />,
    value: (k) => count(k.saleCount),
    metric: (k) => k.saleCount,
    series: 'count',
  },
  {
    id: 'avgSaleValue',
    label: 'Average sale',
    tone: 4,
    icon: <Icons.Wallet size={18} />,
    value: (k) => money(k.avgSaleValue),
    metric: (k) => k.avgSaleValue,
    series: 'turnover',
  },
  {
    id: 'avgItemsPerSale',
    label: 'Items per sale',
    tone: 5,
    icon: <Icons.Boxes size={18} />,
    // Sits last, beside the two figures it only means anything next to: 5.6
    // items reads very differently across 20 sales than across 685, and the
    // row puts all three in one glance.
    value: (k) => decimal(k.avgItemsPerSale),
    metric: (k) => k.avgItemsPerSale,
    series: 'count',
  },
]

export const KPI_BY_ID = new Map(KPI_DEFS.map((d) => [d.id, d]))

/**
 * Type size for a headline figure, chosen by how long it is.
 *
 * A shop turning over R2 000 and one turning over R2 658 421.55 both get a
 * tile the same width, and the second must not be clipped to fit. Stepping the
 * size down keeps the number whole — which matters more than every tile
 * sharing one type size.
 *
 * Measured on the rendered string, so "R821 674.90 (35.5%)" — gross profit
 * with its margin — is counted at its real length rather than its value's.
 *
 * Calibrated against the tile's real width, and kept even though three to a row
 * now gives one ~413px at a 1600px viewport and ~333px at 1366px — wide enough
 * that nothing steps down at all. The tabular `numeric` face advances about
 * 0.6em per character, so the longest figure a tile produces, the 19 of
 * "R860 025.54 (36.5%)", needs ~274px at 24px and clears both. The steps stay
 * because the tiles are laid out by fraction, not by pixels: a narrow window,
 * or a row that ever goes back to more tiles across, has to show its numbers
 * whole rather than wrap them. They simply no longer fire at three to a row.
 */
function valueSize(value: ReactNode): string {
  const length = String(
    typeof value === 'string' || typeof value === 'number' ? value : renderedLength(value),
  ).length

  if (length <= 15) return 'text-2xl'
  if (length <= 17) return 'text-xl'
  if (length <= 20) return 'text-lg'
  return 'text-base'
}

/** Rough character count of a React fragment, for the size step above. */
function renderedLength(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderedLength).join('')
  // An element: walk its children. Anything exotic simply counts as long,
  // which errs toward the smaller size — the safe direction.
  const children = (node as { props?: { children?: ReactNode } }).props?.children
  return children === undefined ? 'xxxxxxxxxxxxxxx' : renderedLength(children)
}

type Delta =
  | { kind: 'none' }
  | { kind: 'new'; up: boolean }
  | { kind: 'change'; text: string; up: boolean }

/**
 * The change against the comparison period.
 *
 * A zero baseline is called out as "new" rather than shown as a percentage:
 * dividing by it either explodes or, worse, quietly reports 100% and reads as
 * a modest improvement on a month that actually traded nothing.
 */
function deltaFor(current: number, base: number | null): Delta {
  if (base === null) return { kind: 'none' }
  if (base === 0) {
    if (current === 0) return { kind: 'change', text: '0%', up: true }
    return { kind: 'new', up: current > 0 }
  }
  const change = ((current - base) / Math.abs(base)) * 100
  return { kind: 'change', text: `${Math.abs(change).toFixed(1)}%`, up: change >= 0 }
}

export function KpiTile({
  def,
  kpis,
  compareKpis,
  compareLabel,
  perDay,
  loading,
}: {
  def: KpiDef
  kpis: SalesKpis
  compareKpis: SalesKpis | null
  compareLabel: string
  perDay: DayBucket[]
  loading?: boolean
}) {
  const colors = useChartColors()
  const color = colors.series[def.tone % colors.series.length]

  const series = perDay.map((d) => (def.series === 'turnover' ? d.turnover : d.saleCount))
  const delta = deltaFor(def.metric(kpis), compareKpis ? def.metric(compareKpis) : null)

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface px-4 pt-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted">{def.label}</div>
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill"
          /* A tint of the tile's own ramp colour. Written inline because the
             colour is data-driven (one of six), and Tailwind cannot emit a
             class it never sees in the source. */
          style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
          aria-hidden
        >
          {def.icon}
        </span>
      </div>

      {/* NOT truncated.
          Truncating here is what produced "R2 658 …" on a dashboard whose only
          job is showing numbers — the clipping hid the problem instead of
          solving it. The size steps down for a long figure instead, so a
          seven-digit turnover fits at a smaller type size and stays readable.
          Nothing here is ever cut off. */}
      <div
        className={`numeric mt-1.5 font-semibold leading-tight text-ink ${valueSize(
          def.value(kpis),
        )} ${loading ? 'opacity-40' : ''}`}
      >
        {def.value(kpis)}
      </div>

      {/* The comparison wraps rather than truncating. "vs same period in July
          2026" clipped to "vs same …" tells the reader nothing, and the tile
          has room for a second line. `title` still carries the full text for a
          narrow viewport. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
        {delta.kind === 'none' ? (
          <span className="text-muted">No comparison data</span>
        ) : (
          <>
            <span
              className={`inline-flex shrink-0 items-center gap-0.5 font-semibold ${
                delta.up ? 'text-success' : 'text-danger'
              }`}
            >
              {delta.up ? <Icons.SortAsc size={12} /> : <Icons.SortDesc size={12} />}
              {delta.kind === 'new' ? 'new' : delta.text}
            </span>
            <span className="text-muted" title={compareLabel}>
              {compareLabel}
            </span>
          </>
        )}
      </div>

      {/* Pinned to the bottom of the tile; any spare cell height falls below
          the value, not between the value and its trend.

          The bottom padding is not decoration: the card clips, and without it
          the halo under the line — and the marker on the lowest reading — would
          be sliced off by the card's edge.

          It shrinks rather than overflowing, because the tile's height is the
          user's — a comparison label that wraps to a second line, or a layout
          saved at a shorter height, takes it out of the chart. Giving up chart
          height is much better than the card clipping it. */}
      <div className="mt-auto min-h-0 shrink pt-3 pb-3">
        {/* A CEILING, not a size. At the default three-row tile there is no
            76px to be had and the chart settles at about 32 — a proper
            sparkline on a tile this wide. What it buys is the tile the user
            drags taller: the chart grows into the room instead of leaving a
            dead band across the middle of the card, and stops at 76 rather than
            becoming a full chart with no axis. */}
        <Sparkline values={series} color={color} height={76} />
      </div>
    </div>
  )
}

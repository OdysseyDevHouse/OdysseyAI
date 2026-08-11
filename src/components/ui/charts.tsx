'use client'

import { useEffect, useState, type ReactNode } from 'react'

/**
 * Chart plumbing — the bridge between the design tokens and Recharts.
 *
 * Recharts writes its colours into SVG attributes (`stroke`, `fill`) and reads
 * some of them back to compute gradients and active states. A `var(--color-…)`
 * survives the first case and not the second, so the tokens have to be
 * RESOLVED to real values before they are handed over. That is the whole job
 * of `useChartColors`.
 *
 * Everything here still comes from globals.css. No chart may name a colour of
 * its own — add a `--color-chart-*` token and read it through this hook, so a
 * restyle stays one edit in one file.
 */

/** Every colour a chart in this app is allowed to use. */
export type ChartColors = {
  /** The categorical ramp, in the order series should consume it. */
  series: string[]
  /** Single-series charts: the brand-tinted first ramp entry. */
  brand: string
  grid: string
  axis: string
  /** The card colour behind the chart — donut slice separators need it. */
  surface: string
  ink: string
  muted: string
  success: string
  danger: string
  /**
   * How hard the halo under a plotted line reads, 0–1. Not a colour: the halo
   * is always the series' own colour, and this only says how much of it
   * survives the blur. Dark mode carries far more of it than light — see
   * `--chart-glow` in globals.css.
   */
  glow: number
}

/** The token names behind each entry, so the list lives in exactly one place. */
const SERIES_TOKENS = [
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
  '--color-chart-6',
]

/**
 * Values used until the first paint resolves the real ones. They match the
 * light theme, so a server render and the first client frame agree and nothing
 * flashes — see the mount guard in the hook.
 */
const FALLBACK: ChartColors = {
  series: ['#2f6fed', '#0d9488', '#d97706', '#7c3aed', '#db2777', '#0e7490'],
  brand: '#2f6fed',
  grid: '#eaecf0',
  axis: '#98a2b3',
  surface: '#ffffff',
  ink: '#16191d',
  muted: '#667085',
  success: '#17a34a',
  danger: '#dc2626',
  glow: 0.3,
}

/** `--chart-glow` as a usable 0–1 number; anything odd falls back. */
function glowStrength(raw: string): number {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return FALLBACK.glow
  return Math.min(1, Math.max(0, value))
}

function readTokens(): ChartColors {
  const styles = getComputedStyle(document.documentElement)
  const read = (token: string, fallback: string) =>
    styles.getPropertyValue(token).trim() || fallback

  return {
    series: SERIES_TOKENS.map((token, i) => read(token, FALLBACK.series[i])),
    brand: read('--color-chart-1', FALLBACK.brand),
    grid: read('--color-chart-grid', FALLBACK.grid),
    axis: read('--color-chart-axis', FALLBACK.axis),
    surface: read('--color-surface', FALLBACK.surface),
    ink: read('--color-ink', FALLBACK.ink),
    muted: read('--color-muted', FALLBACK.muted),
    success: read('--color-success', FALLBACK.success),
    danger: read('--color-danger', FALLBACK.danger),
    // A number rather than a colour, so it can drive an SVG filter's alpha.
    // An unparseable token would put NaN into a filter and blank every line on
    // the dashboard, so it falls back — but a deliberate 0 (glow off) is kept.
    glow: glowStrength(read('--chart-glow', String(FALLBACK.glow))),
  }
}

/**
 * The resolved token values for the CURRENT theme, kept current as it changes.
 *
 * Both routes into dark mode are watched, because they are genuinely different
 * events: the avatar menu sets `data-theme` on <html> (a mutation), while a
 * machine with no explicit choice follows the OS (a media query). Watching only
 * one leaves charts stranded in the previous theme's palette.
 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(FALLBACK)

  useEffect(() => {
    const sync = () => setColors(readTokens())
    sync()

    // Route 1: an explicit choice, written to <html data-theme>.
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    // Route 2: no choice made — follow the operating system.
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', sync)

    return () => {
      observer.disconnect()
      media.removeEventListener('change', sync)
    }
  }, [])

  return colors
}

/**
 * The halo that sits under a plotted line, as an SVG filter.
 *
 * Render it inside a chart's `<defs>` and point the line (and its dots) at it
 * with `filter="url(#id)"`. It blurs whatever it is given, dims the blur to
 * `strength`, and paints the original back on top — so the halo is always the
 * line's own colour and nothing here has to name one.
 *
 * A filter rather than a CSS `drop-shadow` because the shadow would have to be
 * given an explicit colour, and there is one line colour per tile.
 */
export function ChartGlow({
  id,
  strength,
  blur = 3,
}: {
  id: string
  /** Normally `useChartColors().glow`. */
  strength: number
  blur?: number
}) {
  return (
    /* The region is padded well past the source box: a filter clips to its own
       area, and a halo drawn tight to the path would be sliced off square. */
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation={blur} result="blurred" />
      <feComponentTransfer in="blurred" result="halo">
        <feFuncA type="linear" slope={strength} />
      </feComponentTransfer>
      <feMerge>
        <feMergeNode in="halo" />
        {/* The crisp line goes back on top, so the glow never softens it. */}
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  )
}

/**
 * One `{name, value, color}` entry as Recharts hands it to a custom tooltip.
 * Everything is optional and readonly because that is how Recharts types its
 * payload — a stricter shape here just fails to accept the real thing.
 */
type TooltipValue = string | number | readonly (string | number)[]

type TooltipEntry = {
  name?: ReactNode
  value?: TooltipValue
  color?: string
  payload?: unknown
}

/**
 * The tooltip every chart in this app uses.
 *
 * Recharts' built-in one is styled with inline colours that ignore the theme
 * and go unreadable in dark mode, so this replaces it wholesale. Pass it via
 * `<Tooltip content={...} />` and give it a `format` matching the axis, so the
 * number under the cursor reads the same as the number on the scale.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  format = (value) => String(value),
}: {
  active?: boolean
  /* Readonly because that is how Recharts hands its payload over. */
  payload?: readonly TooltipEntry[]
  label?: ReactNode
  /** Formats each value — pass the same formatter the axis uses. */
  format?: (value: string | number) => string
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2 shadow-pop">
      {label !== undefined && label !== '' && (
        <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      )}
      <ul className="flex flex-col gap-1">
        {payload.map((entry, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            {entry.color && (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-pill"
                style={{ background: entry.color }}
                aria-hidden
              />
            )}
            {entry.name !== undefined && <span className="text-muted">{entry.name}</span>}
            <span className="numeric ml-auto font-semibold text-ink">
              {/* A range series (e.g. an area band) hands over a [low, high]
                  pair; format each end so both read in the house style. */}
              {Array.isArray(entry.value)
                ? entry.value.map((v) => format(v)).join(' – ')
                : format((entry.value as string | number | undefined) ?? '')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

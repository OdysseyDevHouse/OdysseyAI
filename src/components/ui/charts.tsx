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

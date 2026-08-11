/**
 * MeterBar — a proportion, drawn.
 *
 * For "how is this total split" and "how far through are we" — an ageing
 * balance across its buckets, reconciled against unreconciled, a count against
 * its target. One bar, segments in order, no axes and no legend unless asked.
 *
 * Deliberately NOT a chart. Recharts is the right tool when a reader needs to
 * compare values across a scale; it is far too much machinery for a 6px rule
 * that says "most of this is the first colour". A chart also brings its own
 * measuring and re-render cost, which a figure this small cannot justify.
 *
 * Colour carries meaning here exactly as it does on Badge — pick the tone for
 * what a segment *means*, not for how the bar looks. A meter whose segments are
 * chosen to look pretty has stopped telling the reader anything.
 */

export type MeterTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral'

export type MeterSegment = {
  label: string
  value: number
  tone: MeterTone
}

/* Full class strings in a lookup, never `bg-${tone}` — Tailwind scans source
   text and cannot emit a class it never literally sees. */
const TONE: Record<MeterTone, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-border-strong',
}

/** The legend dot, which needs the same colour as a small square. */
const DOT: Record<MeterTone, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-border-strong',
}

const HEIGHT: Record<4 | 6 | 10, string> = {
  4: 'h-1',
  6: 'h-1.5',
  10: 'h-2.5',
}

export function MeterBar({
  segments,
  total,
  height = 6,
  showLegend = false,
  className = '',
}: {
  segments: readonly MeterSegment[]
  /**
   * The denominator. Omit it and the segments are the whole bar; pass a larger
   * figure and what is left over stays as track — which is how "R40k of a
   * R100k limit" differs from "this balance, split four ways".
   */
  total?: number
  height?: 4 | 6 | 10
  /** Names and figures under the bar. Off by default: a meter beside its own
      labelled figures does not need to repeat them. */
  showLegend?: boolean
  className?: string
}) {
  // Negatives would render as a backwards segment and silently corrupt every
  // other segment's share, so they are floored rather than trusted.
  const safe = segments.map((s) => ({ ...s, value: Math.max(s.value, 0) }))
  const sum = safe.reduce((acc, s) => acc + s.value, 0)
  const denominator = total !== undefined && total > sum ? total : sum

  // Nothing to draw. An empty track still reads as "zero of something", which
  // is the honest picture, so the bar is rendered rather than skipped.
  const drawable = denominator > 0 ? safe.filter((s) => s.value > 0) : []

  const label = drawable.length
    ? drawable.map((s) => `${s.label}: ${share(s.value, denominator)}`).join(', ')
    : 'Nothing to show'

  return (
    <div className={className}>
      <div
        className={`flex w-full overflow-hidden rounded-pill bg-surface-2 ${HEIGHT[height]}`}
        role="img"
        aria-label={label}
      >
        {/* A zero segment is dropped rather than given 0% — a zero-width div
            still paints a seam against the track. */}
        {drawable.map((s) => (
          <div
            key={s.label}
            className={TONE[s.tone]}
            style={{ width: share(s.value, denominator) }}
            title={`${s.label}: ${share(s.value, denominator)}`}
          />
        ))}
      </div>

      {showLegend && drawable.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {drawable.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-xs text-muted">
              <span className={`size-2 rounded-pill ${DOT[s.tone]}`} aria-hidden="true" />
              {s.label}
              <span className="numeric text-ink-2">{share(s.value, denominator)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function share(value: number, denominator: number): string {
  return `${((value / denominator) * 100).toFixed(1)}%`
}

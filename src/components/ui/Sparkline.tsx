/**
 * Sparkline — a trend, at the size of a word.
 *
 * Deliberately NOT a Recharts instance. A KPI strip renders six of these at
 * once, and six chart engines to draw six 28px shapes is a lot of machinery
 * for a line with no axes, no ticks and no tooltip. This is one <svg> and a
 * path string, so a tile costs nothing to render.
 *
 * It carries no axis and no scale on purpose: a sparkline answers "which way,
 * and how steadily", never "how much". The number it sits under answers that.
 */

/**
 * A smooth path through the points, as a Catmull-Rom spline converted to cubic
 * béziers. Straight segments would put a visible kink at every reading, which
 * reads as noise in the data rather than what it is — the resolution of the
 * sampling.
 */
function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length < 2) return ''
  const tension = 0.2 // lower is smoother
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) * tension
    const c1y = p1[1] + (p2[1] - p0[1]) * tension
    const c2x = p2[0] - (p3[0] - p1[0]) * tension
    const c2y = p2[1] - (p3[1] - p1[1]) * tension
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d
}

export function Sparkline({
  values,
  color,
  height = 28,
  className = '',
}: {
  values: number[]
  /**
   * A resolved colour, normally from `useChartColors()`. It is passed rather
   * than read here so a strip of tiles can each take a different ramp entry.
   */
  color: string
  height?: number
  className?: string
}) {
  const W = 100
  const H = height
  const points = values.filter((v) => Number.isFinite(v))

  // One point is not a trend. Hold the height so a tile with no data is the
  // same size as its neighbours and the row does not go ragged.
  if (points.length < 2) return <div style={{ height: H }} className={className} />

  const max = Math.max(...points)
  const min = Math.min(...points)
  // A flat series has no span to divide by; 1 puts the line through the middle.
  const span = max - min || 1
  const stepX = W / (points.length - 1)
  const y = (v: number) => H - ((v - min) / span) * (H - 2) - 1

  const coords = points.map((v, i) => [i * stepX, y(v)] as const)
  const line = smoothPath(coords)
  const area = `${line} L${W},${H} L0,${H} Z`
  // Unique per colour so two tiles never share a gradient definition.
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, '')}`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`block w-full ${className}`}
      style={{ height: H }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        /* The viewBox is stretched non-uniformly to fill the tile; without this
           the stroke stretches with it and the line goes lumpy. */
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

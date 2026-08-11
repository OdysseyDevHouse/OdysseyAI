'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Sparkline — a trend, at the size of a word.
 *
 * Deliberately NOT a Recharts instance. A KPI strip renders six of these at
 * once, and six chart engines to draw six small shapes is a lot of machinery
 * for a line with no axes, no ticks and no tooltip. This is one <svg> and a
 * path string, so a tile costs nothing to render.
 *
 * It carries no axis and no scale on purpose: a sparkline answers "which way,
 * and how steadily", never "how much". The number it sits under answers that.
 *
 * The line is drawn lit — a marker at each reading and a halo of the line's own
 * colour underneath. The halo is what carries it on the dark surface, where a
 * 1.5px stroke otherwise disappears into the card; `--chart-glow` drops it to a
 * whisper in light mode, where the same halo would read as a smudge.
 */

/** Room for a marker and its halo, so neither is clipped by the viewBox. */
const INSET = 4

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
  height = 44,
  className = '',
}: {
  values: number[]
  /**
   * A resolved colour, normally from `useChartColors()`. It is passed rather
   * than read here so a strip of tiles can each take a different ramp entry.
   */
  color: string
  /**
   * The height it draws at, given room. It is a CEILING, not a fixed size: the
   * box is capped to its parent, so a sparkline in a tile that has run short of
   * space shrinks rather than spilling past the card and being clipped.
   */
  height?: number
  className?: string
}) {
  /* The box is MEASURED rather than stretched. The old version drew into a
     fixed 100-unit viewBox with preserveAspectRatio="none", which is fine for a
     bare line but turns every marker into an ellipse and every halo into a
     horizontal smear. Drawing at the real pixel size keeps circles round and
     the blur even, and costs one observer per tile. */
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height })
  useEffect(() => {
    const node = boxRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) =>
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const { width } = box
  const H = box.height

  const points = values.filter((v) => Number.isFinite(v))

  // One point is not a trend, and a box of zero width has nothing to draw into
  // (the first frame, before the observer reports). Hold the height either way,
  // so a tile with no data is the same size as its neighbours and the row does
  // not go ragged.
  const drawable = points.length >= 2 && width > 0 && H > INSET * 2

  const max = Math.max(...points)
  const min = Math.min(...points)
  // A flat series has no span to divide by; 1 puts the line through the middle.
  const span = max - min || 1
  const stepX = drawable ? (width - INSET * 2) / (points.length - 1) : 0
  const y = (v: number) => H - INSET - ((v - min) / span) * (H - INSET * 2)

  const coords = points.map((v, i) => [INSET + i * stepX, y(v)] as const)
  const line = smoothPath(coords)

  /* Markers only when they can be told apart. At a month's worth of readings in
     a tile this narrow they would run into one another and read as a thick
     line, which is worse than no markers at all — so past that density the
     line carries the trend on its own. */
  const showDots = stepX >= 9

  return (
    /* maxHeight is what makes `height` a ceiling: in a tile that has run out of
       room the box shrinks with its parent instead of overflowing it. Against a
       parent of auto height — the Style Guide, a table cell — the percentage
       resolves to nothing and the plain height stands. */
    <div
      ref={boxRef}
      className={`w-full ${className}`}
      style={{ height, maxHeight: '100%' }}
    >
      {drawable && (
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          className="block overflow-visible"
          style={{
            /* The halo, in the line's own colour at the strength the theme
               asks for. A CSS drop-shadow rather than an SVG filter because the
               viewBox is 1:1 with the box here, so it blurs evenly and needs no
               <defs> in a component that renders six times over. */
            filter: `drop-shadow(0 0 3px color-mix(in srgb, ${color} calc(var(--chart-glow) * 100%), transparent))`,
          }}
          aria-hidden
        >
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {showDots &&
            coords.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={2} fill={color} />)}
        </svg>
      )}
    </div>
  )
}

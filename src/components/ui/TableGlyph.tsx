import { useId, type CSSProperties } from 'react'

/**
 * A table, drawn — the top and its chairs, as one SVG.
 *
 * ── WHY SVG, AND WHY SHARED ───────────────────────────────────────────────
 *
 * The floor plan exists so a waiter can find "the big round one by the window" WITHOUT
 * READING. That only works if a tile looks like the thing it stands for, which a
 * rounded rectangle with a code in it does not. Chairs made of absolutely-positioned
 * divs got most of the way there but could not follow a shape: a round table's seats
 * belong on its circumference, not on the bounding box's edges, and no amount of
 * `inset-x-[15%]` expresses that.
 *
 * One SVG per table solves both. It scales to any tile size without re-tuning pixel
 * offsets, it can place a chair at any angle around an ellipse, and — because it is a
 * single component — the DESIGNER and the TILL cannot drift apart. That last point is
 * the reason this lives in the kit rather than beside either screen: the whole promise
 * of the designer is "this is what the till shows", and two copies of the drawing is
 * exactly how that promise quietly stops being true.
 *
 * ── COLOUR COMES FROM CURRENTCOLOR ────────────────────────────────────────
 *
 * Nothing here names a colour. The table top fills with `currentColor` at low opacity
 * and strokes it at full, so a caller sets one text colour — its own state token — and
 * the whole drawing follows. That is what lets the till tint a tile by occupancy
 * (free / open / bill asked) and the designer tint it by selection, using the same
 * component and no variants.
 */

export type TableGlyphShape = 'rect' | 'round' | 'oval' | 'counter'

/**
 * Where the chairs sit, per edge.
 *
 * Taken as a prop rather than computed here so the caller keeps ownership of the rule
 * (`seatLayout` in floorGeometry, which the presets and the canvas already share) — this
 * component draws what it is told and decides nothing about seating.
 */
export type TableGlyphSeats = {
  top: number
  bottom: number
  left: number
  right: number
}

/* The glyph is drawn in a fixed 100×100 viewBox and stretched by the caller's box, so
   every measurement below is a percentage in disguise. `preserveAspectRatio="none"` is
   what allows a 20×8 counter and an 8×8 two-top to use the same drawing code. */
const VB = 100

/** How much of the box the chairs occupy, leaving the rest to the table top. */
const CHAIR_DEPTH = 13
/** Gap between a chair and the table edge, so they read as separate objects. */
const CHAIR_GAP = 4
/**
 * Smallest gap between neighbouring chairs, in viewBox units.
 *
 * Without a floor here, eight chairs along one edge divide the span into slivers with
 * hairline gaps and the row renders as one solid bar — which says "a bench" when the
 * drawing is meant to say "eight seats". Below this the chairs simply overlap less by
 * shrinking rather than by touching.
 */
const CHAIR_MIN_GAP = 5

/** How far the edge banding sits in from the table's outline. */
const RIM = 4.5

export function TableGlyph({
  shape,
  seats,
  className,
  style,
}: {
  shape: TableGlyphShape
  seats: TableGlyphSeats
  className?: string
  style?: CSSProperties
}) {
  /*
   * A per-instance id prefix for this glyph's gradient, pattern and clip path.
   *
   * SVG ids are DOCUMENT-global, so a floor of forty tables sharing one id means forty
   * elements pointing at whichever definition rendered last — and the whole plan takes
   * the first table's proportions. `useId` is stable across server and client renders,
   * so it also survives hydration, which `Math.random()` would not.
   */
  const uid = useId().replace(/:/g, '')

  /* The table top is inset by however much the chairs need on each side — a table with
     no chairs fills its whole footprint, which is what an unseated counter should do. */
  const inset = {
    top: seats.top > 0 ? CHAIR_DEPTH : 0,
    bottom: seats.bottom > 0 ? CHAIR_DEPTH : 0,
    left: seats.left > 0 ? CHAIR_DEPTH : 0,
    right: seats.right > 0 ? CHAIR_DEPTH : 0,
  }
  const x = inset.left
  const y = inset.top
  const w = VB - inset.left - inset.right
  const h = VB - inset.top - inset.bottom

  /**
   * How much of an edge is actually seatable.
   *
   * A rectangle seats right up to its corners, but a ROUND or OVAL top curves away, and
   * a counter's ends are half-circles — a chair at the extreme of either floats off the
   * shape it is meant to be tucked under. Insetting the usable span keeps every chair
   * against something solid, which is why this is a fraction of the edge rather than a
   * fixed number: it has to hold for a 10-unit two-top and a 34-unit bar alike.
   */
  const curved = shape === 'round' || shape === 'oval' || shape === 'counter'
  const seatable = curved ? 0.62 : 0.9

  /** Whether the top is drawn as an ellipse. A counter is a rounded RECT, not an oval. */
  const curvedTop = shape === 'round' || shape === 'oval'
  /** Corner radius for the rectangular tops — a counter's ends are fully round. */
  const corner = shape === 'counter' ? Math.min(w, h) / 2 : 8

  /** One edge's chairs, spaced evenly along the table's seatable span on that side. */
  const chairsFor = (n: number, side: 'top' | 'bottom' | 'left' | 'right') => {
    if (n <= 0) return null
    const horizontal = side === 'top' || side === 'bottom'
    const edge = horizontal ? w : h
    const span = edge * seatable
    /* Centred on the edge, so the inset is shared between both ends. */
    const start = (horizontal ? x : y) + (edge - span) / 2
    /* Chair length is a share of the span it sits on, capped so two chairs on a long
       counter stay chair-sized rather than becoming two long bars — and floored against
       CHAIR_MIN_GAP so a crowded edge reads as separate seats. */
    const size = Math.max(4, Math.min(span / n - CHAIR_MIN_GAP, 22))
    const thickness = CHAIR_DEPTH - CHAIR_GAP

    return Array.from({ length: n }, (_, i) => {
      /* Evenly spaced centres: the i-th of n sits at (i + 0.5)/n along the span. */
      const centre = start + (span * (i + 0.5)) / n
      const cross =
        side === 'top'
          ? 0
          : side === 'bottom'
            ? VB - thickness
            : side === 'left'
              ? 0
              : VB - thickness

      /*
       * A chair, not a bar: a seat pad with a back rail behind it.
       *
       * The back is the outer third and sits FURTHER from the table, which is what makes
       * a row of these read as chairs facing inward rather than as tick marks. Both
       * pieces are drawn per-side rather than rotated, because `preserveAspectRatio`
       * stretches the viewBox unevenly and a rotation would shear them.
       */
      const cx = horizontal ? centre - size / 2 : cross
      const cy = horizontal ? cross : centre - size / 2
      const cw = horizontal ? size : thickness
      const ch = horizontal ? thickness : size
      /* How much of the chair's depth the back rail takes. */
      const backDepth = thickness * 0.34
      const pad = thickness - backDepth

      /* The back is on the side AWAY from the table top. */
      const back =
        side === 'top'
          ? { x: cx, y: cy, width: cw, height: backDepth }
          : side === 'bottom'
            ? { x: cx, y: cy + pad, width: cw, height: backDepth }
            : side === 'left'
              ? { x: cx, y: cy, width: backDepth, height: ch }
              : { x: cx + pad, y: cy, width: backDepth, height: ch }

      const seat =
        side === 'top'
          ? { x: cx + cw * 0.08, y: cy + backDepth, width: cw * 0.84, height: pad }
          : side === 'bottom'
            ? { x: cx + cw * 0.08, y: cy, width: cw * 0.84, height: pad }
            : side === 'left'
              ? { x: cx + backDepth, y: cy + ch * 0.08, width: pad, height: ch * 0.84 }
              : { x: cx, y: cy + ch * 0.08, width: pad, height: ch * 0.84 }

      return (
        <g key={`${side}-${i}`}>
          {/* Seat pad — lighter, so the two pieces separate. */}
          <rect
            x={seat.x}
            y={seat.y}
            width={seat.width}
            height={seat.height}
            rx={Math.min(seat.width, seat.height) * 0.35}
            fill="currentColor"
            opacity={0.5}
          />
          {/* Back rail — the darker, fuller piece. */}
          <rect
            x={back.x}
            y={back.y}
            width={back.width}
            height={back.height}
            rx={Math.min(back.width, back.height) * 0.45}
            fill="currentColor"
            opacity={0.85}
          />
        </g>
      )
    })
  }

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={`0 0 ${VB} ${VB}`}
      /* Stretched to the caller's box rather than kept square: a table's footprint is
         its real proportions, and letterboxing a counter into a square would draw a
         shape the room does not contain. */
      preserveAspectRatio="none"
      className={className}
      style={style}
    >
      <defs>
        {/*
         * The grain, and the light across the top.
         *
         * A flat fill reads as a coloured box; a top with a gradient across it and a few
         * grain lines reads as a SURFACE, which is the whole difference between a
         * diagram and a picture of furniture. Ids are per-instance (see `uid`) because
         * SVG ids are document-global and a floor of forty tables would otherwise all
         * share — and fight over — one definition.
         */}
        <linearGradient id={`${uid}-top`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.42} />
          <stop offset="55%" stopColor="currentColor" stopOpacity={0.3} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.22} />
        </linearGradient>
        <pattern
          id={`${uid}-grain`}
          patternUnits="userSpaceOnUse"
          width={100}
          height={9}
        >
          <line
            x1={0}
            y1={4.5}
            x2={100}
            y2={4.5}
            stroke="currentColor"
            strokeWidth={1.1}
            opacity={0.12}
          />
        </pattern>
        {/* Clips the grain and rim to the table's own silhouette, so a round top does
            not show square grain in its corners. */}
        <clipPath id={`${uid}-clip`}>
          {curvedTop ? (
            <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} />
          ) : (
            <rect x={x} y={y} width={w} height={h} rx={corner} />
          )}
        </clipPath>
      </defs>

      {/* Chairs first, so the table top overlaps them — furniture tucks under. */}
      {chairsFor(seats.top, 'top')}
      {chairsFor(seats.bottom, 'bottom')}
      {chairsFor(seats.left, 'left')}
      {chairsFor(seats.right, 'right')}

      {/* A contact shadow, offset down-right: the cheapest cue that the top sits ABOVE
          the floor rather than being painted on it. */}
      {curvedTop ? (
        <ellipse
          cx={x + w / 2 + 1.5}
          cy={y + h / 2 + 2}
          rx={w / 2}
          ry={h / 2}
          fill="currentColor"
          opacity={0.16}
        />
      ) : (
        <rect
          x={x + 1.5}
          y={y + 2}
          width={w}
          height={h}
          rx={corner}
          fill="currentColor"
          opacity={0.16}
        />
      )}

      {/* The top itself. */}
      {curvedTop ? (
        <ellipse
          cx={x + w / 2}
          cy={y + h / 2}
          rx={w / 2}
          ry={h / 2}
          fill={`url(#${uid}-top)`}
          stroke="currentColor"
          /* Stroke is scaled by the same stretch that sizes the box, so a wide counter
             would otherwise show a thin top edge and a fat side. vectorEffect keeps it
             even at any aspect ratio. */
          vectorEffect="non-scaling-stroke"
          strokeWidth={2.5}
        />
      ) : (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={corner}
          fill={`url(#${uid}-top)`}
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          strokeWidth={2.5}
        />
      )}

      <g clipPath={`url(#${uid}-clip)`}>
        <rect x={x} y={y} width={w} height={h} fill={`url(#${uid}-grain)`} />
        {/* An inset rim — the edge banding of a real table top, and what gives it
            thickness rather than looking like a sticker. */}
        {curvedTop ? (
          <ellipse
            cx={x + w / 2}
            cy={y + h / 2}
            rx={w / 2 - RIM}
            ry={h / 2 - RIM}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={1}
            opacity={0.4}
          />
        ) : (
          <rect
            x={x + RIM}
            y={y + RIM}
            width={Math.max(0, w - RIM * 2)}
            height={Math.max(0, h - RIM * 2)}
            rx={Math.max(0, corner - RIM)}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={1}
            opacity={0.4}
          />
        )}
      </g>
    </svg>
  )
}

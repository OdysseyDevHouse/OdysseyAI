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

/**
 * Breathing room between the table top and the edge of the viewBox.
 *
 * An SVG clips at its viewBox, and a stroke straddles its path — so a shape drawn flush
 * against the edge loses the outer half of its stroke and that side renders at half
 * width. This reserves enough for the widest stroke here (2.5) plus the contact shadow's
 * 2-unit offset, so nothing is ever trimmed on any side.
 */
const EDGE_PAD = 4

export function TableGlyph({
  shape,
  seats,
  footprint,
  className,
  style,
}: {
  shape: TableGlyphShape
  seats: TableGlyphSeats
  /**
   * The table's real proportions, in whatever units the caller works in — only the
   * RATIO is used.
   *
   * Needed because the drawing is stretched to fit its box, so features drawn at a fixed
   * size in viewBox units come out wider across than down. Pass the same width/height
   * you size the box with. Optional; without it the rim is drawn as if the table were
   * square, which is visibly uneven on anything long.
   */
  footprint?: { width: number; height: number }
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

  /*
   * How far one viewBox unit is stretched on each axis.
   *
   * The viewBox is SQUARE and `preserveAspectRatio="none"` stretches it to whatever box
   * the table occupies, so on a wide table one unit across covers more screen than one
   * unit down. Anything specified as a fixed number of units therefore renders thicker
   * on one axis than the other — which is what made the left and right edges of a long
   * table look thinner than its top and bottom.
   *
   * Dividing each axis by its own scale cancels the stretch, so a chair, a rim and a
   * corner all come out the same visual thickness the whole way round.
   *
   * `footprint` is how the caller states its proportions; without it we assume square,
   * which is exactly the behaviour this had before — uncorrected, but no worse.
   */
  const aspect =
    footprint && footprint.width > 0 && footprint.height > 0
      ? footprint.width / footprint.height
      : 1

  /*
   * ── THE VIEWBOX MATCHES THE FOOTPRINT, SO NOTHING IS EVER STRETCHED ───────
   *
   * This replaces a scheme that drew into a SQUARE viewBox, stretched it to the caller's
   * box with `preserveAspectRatio="none"`, and then divided every single measurement by
   * a per-axis factor to undo the distortion. That scheme was wrong three times running —
   * measured at 1.59, then 0.74, then still visibly uneven — because a stroke, a corner
   * radius and a clip edge each distort under a non-uniform scale in their own way, and
   * no set of pre-divided numbers can cancel all of them at once.
   *
   * Here the coordinate system simply has the table's real proportions: a 20×8 counter is
   * drawn in a 250×100 viewBox, a square top in a 100×100 one. Scaling to the caller's
   * box is then UNIFORM, so a 2-unit stroke is 2 units on every side by construction and
   * there is nothing left to correct. `RIM`, `CHAIR_DEPTH` and the corner radii are plain
   * numbers again.
   */
  const vbW = aspect >= 1 ? VB * aspect : VB
  const vbH = aspect >= 1 ? VB : VB / aspect

  /* One depth, both axes — the scale is uniform now, so a chair is the same thickness
     wherever it sits. Expressed as a share of the SHORTER side so it stays proportionate
     on a long counter rather than growing with the length.
     `+ EDGE_PAD` keeps the BAND (pad + chair) reaching the table, since the chair now
     starts EDGE_PAD in from the viewBox edge; the chair itself keeps its own thickness,
     which is `depth - EDGE_PAD` where it is drawn below. */
  const depth = (CHAIR_DEPTH / 100) * Math.min(vbW, vbH) + EDGE_PAD

  /*
   * ── EVERY SIDE GETS AT LEAST `EDGE_PAD`, AND THAT IS THE BUG FIX ──────────
   *
   * A stroke straddles its path: half inside, half outside. A shape drawn flush against
   * the viewBox edge therefore has the outer half of its stroke CLIPPED AWAY, and the
   * side reads as a half-width line.
   *
   * Chairs used to be the only thing insetting the top, so a table with chairs above and
   * below (the common case) sat flush left and right — full stroke top and bottom, half
   * stroke on the sides. That is the "thinner on the left and right" everyone could see
   * and no amount of correcting the rim arithmetic could touch, because the rim was never
   * what was wrong.
   *
   * The pad is the visible half of the stroke plus a hair, so nothing is ever trimmed.
   */
  const inset = {
    top: Math.max(EDGE_PAD, seats.top > 0 ? depth : 0),
    bottom: Math.max(EDGE_PAD, seats.bottom > 0 ? depth : 0),
    left: Math.max(EDGE_PAD, seats.left > 0 ? depth : 0),
    right: Math.max(EDGE_PAD, seats.right > 0 ? depth : 0),
  }
  const x = inset.left
  const y = inset.top
  const w = vbW - inset.left - inset.right
  const h = vbH - inset.top - inset.bottom

  /* Plain numbers again: no axis needs its own version of anything. */
  const rim = (RIM / 100) * Math.min(vbW, vbH)

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
  /* One radius, both axes — the scale is uniform, so a corner curves the same way round.
     A counter's ends stay fully round, which is what makes it a counter. */
  const corner =
    shape === 'counter'
      ? Math.min(w, h) / 2
      : (8 / 100) * Math.min(vbW, vbH)

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
       CHAIR_MIN_GAP so a crowded edge reads as separate seats.

       All in one set of units now — the scale is uniform, so a chair on a wide table is
       already the same size as one on a narrow table with no per-axis fiddling. */
    const unit = Math.min(vbW, vbH) / 100
    const gap = CHAIR_MIN_GAP * unit
    const size = Math.max(4 * unit, Math.min(span / n - gap, 22 * unit))
    /* `- EDGE_PAD` so the chair keeps the thickness it had before the pad was introduced
       — the pad moved its start inward, and without this it would simply grow by that
       much and read as a fat slab rather than a chair. */
    const thickness = depth - EDGE_PAD - CHAIR_GAP * unit

    return Array.from({ length: n }, (_, i) => {
      /* Evenly spaced centres: the i-th of n sits at (i + 0.5)/n along the span. */
      const centre = start + (span * (i + 0.5)) / n
      /* Pulled in by EDGE_PAD like the top is, so a chair against the outer edge is not
         clipped either — it has no stroke, but a rounded end still loses its curve. */
      const cross =
        side === 'top'
          ? EDGE_PAD
          : side === 'bottom'
            ? vbH - thickness - EDGE_PAD
            : side === 'left'
              ? EDGE_PAD
              : vbW - thickness - EDGE_PAD

      /*
       * A chair, not a bar: a seat pad with a back rail behind it.
       *
       * The back is the outer third and sits FURTHER from the table, which is what makes
       * a row of these read as chairs facing inward rather than as tick marks. Drawn
       * per-side rather than rotated — four explicit cases read more plainly here than a
       * transform would.
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
      /* The viewBox already HAS the table's proportions (see `vbW`/`vbH`), so scaling to
         the caller's box is uniform and nothing is distorted. `none` is still correct
         here: the caller sizes the box from the same footprint, so the two ratios agree
         and there is nothing to letterbox — but should they ever disagree, filling the
         box the caller asked for is the behaviour every screen already depends on. */
      viewBox={`0 0 ${vbW} ${vbH}`}
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
        {/* Grain spacing needs no correction now — the scale is uniform, so a line every
            9 units is 9 units apart on screen in every direction. */}
        <pattern id={`${uid}-grain`} patternUnits="userSpaceOnUse" width={vbW} height={9}>
          <line
            x1={0}
            y1={4.5}
            x2={vbW}
            y2={4.5}
            stroke="currentColor"
            strokeWidth={1.1}
            opacity={0.12}
          />
        </pattern>
        {/* Clips the GRAIN to the table's silhouette, so a round top does not show square
            grain in its corners. The rim is deliberately outside this — see below. */}
        <clipPath id={`${uid}-clip`}>
          {curvedTop ? (
            <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} />
          ) : (
            <rect x={x} y={y} width={w} height={h} rx={corner} ry={corner} />
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
          ry={corner}
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
          /* `non-scaling-stroke` keeps the outline a constant screen width whatever the
             table's size — a small table would otherwise get a hairline and a bar a slab.
             It no longer has to compensate for a distortion, because there is none. */
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
          ry={corner}
          fill={`url(#${uid}-top)`}
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          strokeWidth={2.5}
        />
      )}

      {/* The grain, and ONLY the grain, is clipped to the table's outline — a square
          pattern would otherwise show in the corners of a round top. */}
      <g clipPath={`url(#${uid}-clip)`}>
        <rect x={x} y={y} width={w} height={h} fill={`url(#${uid}-grain)`} />
      </g>

      {/* The edge banding. ONE inset on every side, which is only correct because the
          coordinate system is no longer distorted — this is the line whose left and right
          edges kept reading thinner than its top and bottom, through three failed
          attempts at cancelling a stretch that should not have existed. It sits outside
          the clip above so its stroke is not shaved by the clip edge. */}
      {curvedTop ? (
        <ellipse
          cx={x + w / 2}
          cy={y + h / 2}
          rx={Math.max(0.5, w / 2 - rim)}
          ry={Math.max(0.5, h / 2 - rim)}
          fill="none"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          strokeWidth={1}
          opacity={0.4}
        />
      ) : (
        <rect
          x={x + rim}
          y={y + rim}
          width={Math.max(0, w - rim * 2)}
          height={Math.max(0, h - rim * 2)}
          rx={Math.max(0, corner - rim)}
          ry={Math.max(0, corner - rim)}
          fill="none"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          strokeWidth={1}
          opacity={0.4}
        />
      )}
    </svg>
  )
}

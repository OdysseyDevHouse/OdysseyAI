import { useId, type CSSProperties } from 'react'

/**
 * The fixed furniture of a room — a wall, a bar, a pass, a door, a plant — drawn.
 *
 * ── THE COMPANION TO TableGlyph, AND FOR THE SAME REASON ──────────────────
 *
 * A floor plan earns its keep by being recognisable WITHOUT READING. Tables got there
 * first; the furniture around them was still six differently-tinted rectangles, which
 * meant the one thing a plan is for — "the bar runs along that wall, the door is in the
 * corner" — had to be worked out from colour alone. A door and a pass are not the same
 * kind of object and should not be the same drawing.
 *
 * Shared between the designer and the till for the reason TableGlyph is: the designer
 * promises "this is what the till shows", and two copies of a drawing is exactly how
 * that promise quietly stops being true.
 *
 * ── EACH KIND IS DRAWN AS THE THING IT IS ─────────────────────────────────
 *
 *   wall   a solid run with a hatched face, so it reads as masonry rather than as a
 *          long table — the confusion that mattered most, since both are rectangles
 *   bar    a counter with a service edge marked along one side
 *   pass   a hatched shelf, the kitchen side of the same idea
 *   door   an arc — the swing, which is how every floor plan in the world draws one
 *   plant  a pot with foliage above it
 *   text   nothing at all; a label is its own drawing
 *
 * ── COLOUR COMES FROM currentColor ────────────────────────────────────────
 *
 * Nothing here names a colour, exactly as in TableGlyph: the caller sets one text colour
 * and the whole drawing follows, so selection in the designer and the room's own palette
 * on the till are the same mechanism with no variants.
 */

export type FeatureGlyphKind = 'wall' | 'bar' | 'pass' | 'door' | 'plant' | 'text'

/* Drawn in a fixed 100×100 viewBox and stretched by the caller's box, so every number
   below is a percentage in disguise. `preserveAspectRatio="none"` is what lets a 24×2
   wall and a 10×6 door share one drawing routine. */
const VB = 100

/**
 * Margin for the two drawings that keep their aspect ratio.
 *
 * They render with `preserveAspectRatio="slice"`, which fills the caller's box and crops
 * the overflow — so a door drawn edge to edge would lose its jamb in any box that is not
 * square. Padding them keeps the whole drawing inside the crop.
 */
const DOOR_PAD = 14

export function FeatureGlyph({
  kind,
  className,
  style,
}: {
  kind: FeatureGlyphKind
  className?: string
  style?: CSSProperties
}) {
  /*
   * Per-instance ids for this glyph's patterns and gradients.
   *
   * SVG ids are DOCUMENT-global, so keying them by KIND alone meant two walls of
   * different proportions shared one pattern — and the second silently took the first's
   * geometry. `useId` is stable across server and client renders, so it survives
   * hydration too.
   */
  const uid = useId().replace(/:/g, '')

  /* A label needs no drawing — the text IS the feature, and a box around it would make
     a sign look like a fixture. */
  if (kind === 'text') return null

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={`0 0 ${VB} ${VB}`}
      /*
       * Stretched to the caller's box — EXCEPT the plant and the door.
       *
       * A wall, bar and pass are runs of a length the user chose, so distorting them is
       * correct and expected. The plant's leaves are drawn with `rotate()`, and rotation
       * under an uneven stretch SHEARS: a plant in a 2:1 box comes out as a smear. The
       * door's swing is a circular ARC, which stretches into a lopsided ellipse for the
       * same reason — and a door that does not sweep a quarter circle stops reading as a
       * door.
       *
       * `slice`, not `meet`: meet letterboxes to the SMALLER dimension, which shrank a
       * plant in a 7×9 box to a speck with empty space around it. slice fills the box
       * and crops the overflow, which for a centred drawing costs only its margins.
       */
      preserveAspectRatio={kind === 'plant' || kind === 'door' ? 'xMidYMid slice' : 'none'}
      className={className}
      style={style}
    >
      <defs>
        {/* Brick courses, for the wall: staggered blocks read as masonry where a 45°
            hatch reads as "some hatched region" and could be anything. */}
        <pattern id={`${uid}-brick`} patternUnits="userSpaceOnUse" width={40} height={20}>
          <line x1={0} y1={0} x2={40} y2={0} stroke="currentColor" strokeWidth={2} opacity={0.35} />
          <line x1={0} y1={10} x2={40} y2={10} stroke="currentColor" strokeWidth={2} opacity={0.35} />
          <line x1={10} y1={0} x2={10} y2={10} stroke="currentColor" strokeWidth={2} opacity={0.35} />
          <line x1={30} y1={10} x2={30} y2={20} stroke="currentColor" strokeWidth={2} opacity={0.35} />
        </pattern>
        {/* The pass keeps a hatch — it is a shelf, not a built structure. */}
        <pattern
          id={`${uid}-hatch`}
          patternUnits="userSpaceOnUse"
          width={10}
          height={10}
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={10} stroke="currentColor" strokeWidth={4} opacity={0.5} />
        </pattern>
        {/* A polished counter top, lit from the service side. */}
        <linearGradient id={`${uid}-counter`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.45} />
          <stop offset="40%" stopColor="currentColor" stopOpacity={0.24} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.32} />
        </linearGradient>
      </defs>

      {kind === 'wall' && (
        <>
          {/* Solid body plus brick coursing: a wall has to be unmistakably NOT a long
              table, and masonry is the thing it actually is. */}
          <rect x={0} y={0} width={VB} height={VB} fill="currentColor" opacity={0.5} />
          <rect x={0} y={0} width={VB} height={VB} fill={`url(#${uid}-brick)`} />
          {/* A lit top edge and a shadowed bottom — a wall has height, and this is what
              stops it reading as a flat painted strip. */}
          <rect x={0} y={0} width={VB} height={14} fill="currentColor" opacity={0.28} />
          <rect x={0} y={VB - 12} width={VB} height={12} fill="currentColor" opacity={0.3} />
          <rect
            x={0}
            y={0}
            width={VB}
            height={VB}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2}
          />
        </>
      )}

      {kind === 'bar' && (
        <>
          <rect
            x={0}
            y={0}
            width={VB}
            height={VB}
            rx={6}
            fill={`url(#${uid}-counter)`}
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2.5}
          />
          {/* The service edge — the side people stand at. A bar without one is just a
              rounded rectangle, which is what a table already looks like. */}
          <rect x={0} y={0} width={VB} height={20} rx={5} fill="currentColor" opacity={0.55} />
          {/* Stools along the service side, so it reads as somewhere you sit. */}
          {[20, 50, 80].map((cx) => (
            <circle key={cx} cx={cx} cy={31} r={6} fill="currentColor" opacity={0.4} />
          ))}
          {/* The bottle shelf behind. */}
          <line
            x1={6}
            y1={VB - 16}
            x2={VB - 6}
            y2={VB - 16}
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={1.5}
            opacity={0.45}
          />
        </>
      )}

      {kind === 'pass' && (
        <>
          <rect
            x={0}
            y={0}
            width={VB}
            height={VB}
            rx={4}
            fill="currentColor"
            fillOpacity={0.16}
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2.5}
          />
          <rect x={0} y={0} width={VB} height={VB} fill={`url(#${uid}-hatch)`} opacity={0.5} />
          {/* Heat-lamp ticks along the top — what tells a pass from any other shelf. */}
          {[18, 50, 82].map((cx) => (
            <rect
              key={cx}
              x={cx - 9}
              y={5}
              width={18}
              height={4}
              rx={2}
              fill="currentColor"
              opacity={0.55}
            />
          ))}
        </>
      )}

      {kind === 'door' && (
        <>
          {/* The swing: the opening it sits in, the leaf, and the arc it sweeps. Drawn
              rather than tinted because a doorway is the one feature whose ORIENTATION a
              waiter reads — which way it opens is the whole information.

              The arc is filled as well as stroked: an outline alone was nearly invisible
              at the size a door is actually placed, and the filled quadrant is what makes
              the swing read at a glance. */}
          {/* Inset to DOOR_PAD on every side: `slice` crops whatever overflows the
              shorter axis, so the drawing has to live inside a safe centre. */}
          <path
            d={`M ${DOOR_PAD} ${VB - DOOR_PAD}
                L ${VB - DOOR_PAD} ${VB - DOOR_PAD}
                A ${VB - DOOR_PAD * 2} ${VB - DOOR_PAD * 2} 0 0 0 ${DOOR_PAD} ${DOOR_PAD} Z`}
            fill="currentColor"
            fillOpacity={0.2}
          />
          <path
            d={`M ${VB - DOOR_PAD} ${VB - DOOR_PAD}
                A ${VB - DOOR_PAD * 2} ${VB - DOOR_PAD * 2} 0 0 0 ${DOOR_PAD} ${DOOR_PAD}`}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2.5}
            strokeDasharray="7 6"
          />
          {/* The leaf, hinged bottom-left and standing open. Thickest line here, because
              the door itself is the object and the arc is only its path. */}
          <path
            d={`M ${DOOR_PAD} ${VB - DOOR_PAD} L ${DOOR_PAD} ${DOOR_PAD}`}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={8}
            strokeLinecap="round"
          />
          {/* The threshold it swings across. */}
          <path
            d={`M ${DOOR_PAD} ${VB - DOOR_PAD} L ${VB - DOOR_PAD} ${VB - DOOR_PAD}`}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={5}
            strokeLinecap="round"
          />
        </>
      )}

      {kind === 'plant' && (
        <>
          {/*
           * Actual LEAVES rather than blobs — each a teardrop with a central vein,
           * splayed from the crown at different angles and lengths.
           *
           * Ellipses read as "some green shapes"; a pointed leaf with a vein reads as
           * foliage even at tile size. Asymmetry is deliberate: evenly-spaced round
           * blobs read as a face, which a pot plant should not.
           */}
          {/* Crown at y=58, so foliage and pot together span roughly y=22..94 — inside
              the safe centre `slice` leaves when the box is not square. */}
          {[
            { rot: -52, len: 28, w: 11, dim: 0.34 },
            { rot: -20, len: 34, w: 13, dim: 0.44 },
            { rot: 12, len: 31, w: 12, dim: 0.38 },
            { rot: 46, len: 25, w: 10, dim: 0.32 },
            { rot: -78, len: 21, w: 9, dim: 0.28 },
            { rot: 76, len: 20, w: 9, dim: 0.26 },
          ].map((leaf, i) => (
            <g key={i} transform={`rotate(${leaf.rot} 50 58)`}>
              {/* A teardrop: two symmetric curves meeting at a tip. */}
              <path
                d={`M 50 58
                    C ${50 - leaf.w} ${58 - leaf.len * 0.45}, ${50 - leaf.w * 0.55} ${58 - leaf.len * 0.9}, 50 ${58 - leaf.len}
                    C ${50 + leaf.w * 0.55} ${58 - leaf.len * 0.9}, ${50 + leaf.w} ${58 - leaf.len * 0.45}, 50 58 Z`}
                fill="currentColor"
                fillOpacity={leaf.dim}
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
                strokeWidth={1.2}
                strokeOpacity={0.55}
              />
              <line
                x1={50}
                y1={58}
                x2={50}
                y2={58 - leaf.len * 0.82}
                stroke="currentColor"
                vectorEffect="non-scaling-stroke"
                strokeWidth={1}
                opacity={0.4}
              />
            </g>
          ))}
          {/* The pot: a tapered body with a rim, so it reads as a container rather than
              a triangle. */}
          <path
            d={`M 37 68 L 63 68 L 58 94 L 42 94 Z`}
            fill="currentColor"
            fillOpacity={0.5}
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <rect
            x={34}
            y={62}
            width={32}
            height={8}
            rx={2}
            fill="currentColor"
            fillOpacity={0.68}
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2}
          />
        </>
      )}
    </svg>
  )
}

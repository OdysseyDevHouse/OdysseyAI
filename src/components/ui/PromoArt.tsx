/**
 * The small drawing that sits beside a promo panel's copy.
 *
 * ── WHY A DRAWING IS IN THE KIT AT ALL ────────────────────────────────────
 *
 * Everywhere else in this app a picture would be decoration, and decoration is
 * what the craft rules spend most of their words keeping out. A promo panel is
 * the exception, and only because of where it sits: the dead space at the foot
 * of a drawer, below the last real control. An icon there reads as a control
 * that has stopped working; a line of text alone reads as a sentence somebody
 * forgot to delete. A drawing reads as what it is — the panel's own furniture.
 *
 * Here rather than inline in the till's module menu so that the second panel to
 * want one does not draw its own. Two hand-rolled bags is exactly how a kit
 * stops being one.
 *
 * ── COLOUR COMES FROM TOKENS, NOT FROM THE DRAWING ────────────────────────
 *
 * Every stroke and fill is `currentColor` at an opacity, so the caller sets one
 * text colour — `text-brand` — and the whole thing follows it into dark mode and
 * through any rebrand. A drawing with hexes baked in is a corner of the app that
 * silently stops matching the rest, and it is always the corner nobody looks at.
 */

export type PromoArtKind = 'bag'

export function PromoArt({
  kind = 'bag',
  className = '',
}: {
  kind?: PromoArtKind
  className?: string
}) {
  if (kind !== 'bag') return null

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 120 120"
      className={className}
    >
      {/* The bag: a tapered body with a fold at the top, and a handle above it.
          Drawn open-topped so the cube below can sit half inside it — the two
          together say "the things you sell, and where they go", which one of
          them alone does not. */}
      <path
        d="M 30 44 L 90 44 L 84 104 C 83.5 108 80.5 111 76.5 111 L 43.5 111 C 39.5 111 36.5 108 36 104 Z"
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeOpacity={0.55}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {/* The fold, which is what stops it reading as a plant pot. */}
      <path
        d="M 30 44 L 90 44 L 88.5 58 L 31.5 58 Z"
        fill="currentColor"
        fillOpacity={0.3}
      />
      {/* The handle. Two verticals and an arc, not a single stroke: a bag's
          handle is attached at two points and the gap between them is the part
          the eye recognises. */}
      <path
        d="M 45 44 L 45 33 C 45 24.7 51.7 18 60 18 C 68.3 18 75 24.7 75 33 L 75 44"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={4}
        strokeLinecap="round"
      />

      {/* A box coming out of it, drawn as an isometric cube so it reads as goods
          rather than as a square on the bag. Three faces at three opacities is
          the whole trick — a flat one would just be a hole. */}
      <g transform="translate(58 56)">
        {/* Top face. */}
        <path d="M 26 0 L 50 12 L 26 24 L 2 12 Z" fill="currentColor" fillOpacity={0.9} />
        {/* Left face, in shadow. */}
        <path d="M 2 12 L 26 24 L 26 50 L 2 38 Z" fill="currentColor" fillOpacity={0.55} />
        {/* Right face, lit. */}
        <path d="M 50 12 L 50 38 L 26 50 L 26 24 Z" fill="currentColor" fillOpacity={0.72} />
      </g>
    </svg>
  )
}

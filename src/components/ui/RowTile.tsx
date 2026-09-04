import { tileClass } from './tiles'

/**
 * RowTile — the leading identity tile on a list row: a coloured disc with
 * the record's initials, so a row is findable by shape rather than by reading.
 * Worth its 30px on any list of products or people (see odyssey-craft).
 *
 * Pass the record's stored swatch token so the colour is stable per record;
 * with no token the colour is derived from the label, which is still stable
 * across renders and sorts.
 */
/**
 * `lg` is the same tile at page-heading scale.
 *
 * A size rather than a className override at the call site: the 30px default is
 * tuned for a table row, and a page header that scaled it with a utility would
 * be the second place deciding how big an identity tile is. Both steps keep the
 * initials optically centred, which is what a bare `size-*` override loses.
 */
const SIZE = {
  default: 'size-[34px] rounded-full text-xs',
  lg: 'size-12 rounded-full text-base',
} as const

export function RowTile({
  label,
  token,
  size = 'default',
  className = '',
}: {
  /** The record's name — initials are derived from its first two words. */
  label: string
  /** A stored tile-swatch token (see tiles.ts). Omit to derive from the label. */
  token?: string | null
  size?: keyof typeof SIZE
  className?: string
}) {
  const swatch = token ?? `tile-${(hash(label) % 7) + 1}`
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-semibold text-white ${SIZE[size]} ${tileClass(swatch)} ${className}`}
    >
      {initials(label)}
    </span>
  )
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/* Small stable string hash — good enough to spread labels across 7 swatches. */
function hash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * RowGlyph — a list row's identity mark when the record may have a PICTURE.
 *
 * The record's own image when it has one, and `RowTile`'s initials disc when it
 * has not. Lifted out of the departments screen, which drew exactly this by
 * hand, so the products list could show a product's till icon the same way
 * rather than becoming a second definition of "the picture on a row".
 *
 * ── WHY THE PICTURE IS SQUARE AND THE FALLBACK IS A CIRCLE ────────────────
 *
 * They are not the same object. The initials disc is a generated placeholder —
 * round, because that is what it has always been on every list in the app, and
 * changing it here would restyle rows that have nothing to do with pictures.
 * A stored picture is the shopkeeper's own artwork: it needs a box that will
 * not crop it, because a circular mask eats the corners of a logo somebody
 * uploaded deliberately. `object-contain` inside a square is what keeps a
 * non-square upload from being stretched into one.
 *
 * `src` is a URL rather than an id: a department's picture lives behind
 * /api/storefront-images/<id> and a product's behind /api/product-icon/<id>,
 * which are two different routes. Passing the finished URL keeps this
 * component out of the business of knowing which record it is drawing.
 */
export function RowGlyph({
  label,
  token,
  src,
  className = '',
}: {
  /** The record's name — used for the fallback's initials. */
  label: string
  /** Stored swatch token for the fallback disc. */
  token?: string | null
  /** The picture's URL, or null when the record has none. */
  src?: string | null
  className?: string
}) {
  if (!src) return <RowTile label={label} token={token} className={className} />

  return (
    /* data-kit-ok: a stored picture at row scale. RowTile draws initials on a
       token fill and has no image form; the box around the picture is what
       keeps a non-square upload from being stretched into one. */
    <span
      data-kit-ok
      aria-hidden
      className={`flex size-[34px] shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface-2 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="size-full object-contain" />
    </span>
  )
}

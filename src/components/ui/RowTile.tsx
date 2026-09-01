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

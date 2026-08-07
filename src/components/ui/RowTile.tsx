import { tileClass } from './tiles'

/**
 * RowTile — the leading identity tile on a list row: a coloured square with
 * the record's initials, so a row is findable by shape rather than by reading.
 * Worth its 26px on any list of products or people (see odyssey-craft).
 *
 * Pass the record's stored swatch token so the colour is stable per record;
 * with no token the colour is derived from the label, which is still stable
 * across renders and sorts.
 */
export function RowTile({
  label,
  token,
  className = '',
}: {
  /** The record's name — initials are derived from its first two words. */
  label: string
  /** A stored tile-swatch token (see tiles.ts). Omit to derive from the label. */
  token?: string | null
  className?: string
}) {
  const swatch = token ?? `tile-${(hash(label) % 7) + 1}`
  return (
    <span
      aria-hidden
      className={`flex size-[26px] shrink-0 items-center justify-center rounded-control text-[11px] font-semibold text-white ${tileClass(swatch)} ${className}`}
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

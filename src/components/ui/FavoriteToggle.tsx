'use client'

import { Star } from './icons'

/**
 * The star that marks something as a favourite.
 *
 * Not a Button variant: a Button is a control with a background, a height and a
 * border that reads as clickable chrome. This is a bare state marker that sits
 * inside a card or a row and must not compete with the content it decorates —
 * every button treatment tried here read as a second action on the row.
 *
 * It is always rendered filled-or-not rather than appearing on hover, because
 * "which of these have I starred" is the question the list exists to answer.
 */
export function FavoriteToggle({
  starred,
  onToggle,
  label,
  size = 16,
}: {
  starred: boolean
  onToggle: () => void
  /** What is being starred, for the screen-reader label: "Sales by product". */
  label: string
  size?: number
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={starred ? `Remove ${label} from favourites` : `Add ${label} to favourites`}
      aria-pressed={starred}
      className="-m-1 shrink-0 rounded-control p-1 text-faint transition-colors hover:bg-surface-2 hover:text-warning focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
    >
      <Star size={size} className={starred ? 'fill-warning text-warning' : ''} />
    </button>
  )
}

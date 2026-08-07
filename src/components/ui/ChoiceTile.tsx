'use client'

import type { ReactNode } from 'react'

/**
 * A tile that IS the choice — clicking it acts and moves on.
 *
 * Distinct from `SelectableCard`, which wraps a radio or checkbox and holds a
 * selection until something else submits it. This one has no selected state to
 * hold: picking a dataset in the report builder advances the screen, so a
 * control that stays visibly "checked" would be describing a state that no
 * longer exists.
 *
 * Reads as a button (hover, focus ring, whole surface hittable) while looking
 * like a card, which is what makes a grid of them scannable.
 *
 * Two layouts, because a grid of choices is scanned two different ways:
 *   `stacked` — icon above the title. Roomier; use when the tile is the main
 *               thing on the screen and there are only a handful.
 *   `inline`  — icon beside the title. Denser; use for a long list where the
 *               names are what the eye is running down.
 */
export function ChoiceTile({
  title,
  description,
  icon,
  footer,
  layout = 'stacked',
  onClick,
  disabled,
}: {
  title: string
  description?: string
  /** Usually a `CategoryTile` — it carries the subject's colour. */
  icon?: ReactNode
  /** Pinned to the bottom edge, so it lines up across a row of tiles. */
  footer?: ReactNode
  layout?: 'stacked' | 'inline'
  onClick: () => void
  disabled?: boolean
}) {
  const base =
    'flex h-full rounded-card border border-border bg-surface text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'

  if (layout === 'inline') {
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={`${base} items-start gap-3 p-3`}>
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{title}</span>
          {description && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{description}</span>
          )}
          {footer && <span className="mt-1.5 block">{footer}</span>}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} flex-col items-start gap-2 p-4`}
    >
      {icon}
      <span className="text-sm font-semibold text-ink">{title}</span>
      {description && <span className="text-xs text-muted">{description}</span>}
      {/* mt-auto pins the footer to the bottom so badges align across a row
          even when the descriptions run to different lengths. */}
      {footer && <span className="mt-auto pt-1.5">{footer}</span>}
    </button>
  )
}

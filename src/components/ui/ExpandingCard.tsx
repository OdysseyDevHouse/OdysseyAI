'use client'

import type { ReactNode } from 'react'

/**
 * A card whose header is a button, revealing actions when it is open.
 *
 * The till's basket is built from these: tapping a line opens a row of ＋ − Edit
 * Void beneath it, and only one line is open at a time. That is what keeps a
 * fifteen-line basket readable — four buttons on every line would put sixty
 * targets on screen — while still putting a line's actions one tap away.
 *
 * `DataTable` cannot express it, which is the reason this exists rather than a
 * table variant: a row that GROWS to hold a second row of controls is not a
 * table row, and forcing it into one produced the colspan-and-nested-div mess
 * this replaced.
 *
 * The kit owns it so the border, radius and selected tint match every other
 * surface, and so a second screen wanting the shape does not hand-roll a button.
 */
export function ExpandingCard({
  header,
  actions,
  open = false,
  onToggle,
  className = '',
}: {
  /** The always-visible content. The whole of it is the hit target. */
  header: ReactNode
  /** Revealed under a divider when open. Omit for a card that only selects. */
  actions?: ReactNode
  open?: boolean
  onToggle?: () => void
  className?: string
}) {
  return (
    <div
      className={`rounded-card border p-3.5 shadow-card transition ${
        open ? 'border-brand bg-brand-soft' : 'border-border bg-surface'
      } ${className}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-col gap-1 text-left"
      >
        {header}
      </button>

      {open && actions && (
        <div className="mt-3 flex items-stretch gap-2 border-t border-border pt-3">{actions}</div>
      )}
    </div>
  )
}

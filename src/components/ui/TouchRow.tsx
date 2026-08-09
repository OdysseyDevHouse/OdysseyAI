'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from './icons'

/**
 * A full-width, touch-sized row that is a button.
 *
 * The kit's `Button` is one line of centred label; this is the other shape a till
 * needs constantly — a leading glyph, a title with a subtitle under it, something
 * optional on the right, and the WHOLE thing tappable. "Attach customer / For
 * account sales", "Table 12 / 4 covers, takeaway", "Saved sale #4 / 3 items,
 * R249.90".
 *
 * It exists because the alternative is a hand-rolled <button> at each call site,
 * which check-ui-kit rightly refuses: three screens each inventing their own
 * padding and border for the same shape is exactly the drift the kit prevents.
 *
 * The hit target is the entire row rather than a chevron on it. A finger reaching
 * for a 20px affordance on a list that can scroll is a mis-tap, and on a till a
 * mis-tap happens with a customer watching.
 */
export function TouchRow({
  icon,
  title,
  subtitle,
  trailing,
  showChevron = true,
  tone = 'default',
  disabled = false,
  onClick,
  className = '',
}: {
  /** Usually a CategoryTile or a round tinted glyph. */
  icon?: ReactNode
  title: string
  subtitle?: string
  /** An amount, a badge — anything that belongs on the right. */
  trailing?: ReactNode
  showChevron?: boolean
  /** `active` when the row represents something currently chosen. */
  tone?: 'default' | 'active'
  disabled?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 rounded-card border p-3 text-left transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50 ${
        tone === 'active'
          ? 'border-brand/40 bg-brand-soft'
          : 'border-border bg-surface hover:border-brand/50'
      } ${className}`}
    >
      {icon}

      <span className="min-w-0 flex-1">
        {/* 15px, above the back office's 14px: read at arm's length on a counter
            screen rather than at desk distance. */}
        <span className="block truncate text-[15px] font-semibold text-ink">{title}</span>
        {subtitle && <span className="block truncate text-[13px] text-muted">{subtitle}</span>}
      </span>

      {trailing}
      {showChevron && <ChevronRight size={18} className="shrink-0 text-muted" />}
    </button>
  )
}

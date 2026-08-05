import type { ReactNode } from 'react'

/**
 * One setting: an icon, a name, a line explaining what it does, and its control
 * on the right.
 *
 * Built as a kit component rather than repeated inline because a settings
 * screen is dozens of these — the Properties tab alone has fifteen. Laying each
 * one out by hand is how the icon tile, the label weight and the row divider
 * drift apart from one screen to the next.
 *
 * The control is passed in rather than described by props: a row may hold a
 * Switch, a NumberInput, a Select or anything else, and enumerating those here
 * would mean editing this file every time a new kind of setting appears.
 */
export function SettingRow({
  icon,
  label,
  description,
  children,
  htmlFor,
}: {
  /** Small glyph in the tinted tile. Use an icon from '@/components/ui/icons'. */
  icon?: ReactNode
  label: string
  description?: string
  /** The control itself — Switch, NumberInput, Select, … */
  children: ReactNode
  /**
   * Ties the label to the control for screen readers and click-to-focus. Omit
   * for a Switch, which carries its own accessible name.
   */
  htmlFor?: string
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border px-6 py-4 last:border-b-0">
      {icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
          {icon}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-ink"
        >
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>

      {/* Controls keep their natural width and sit hard right, so a column of
          switches lines up regardless of how long each description runs. */}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * A group of SettingRows under a heading.
 *
 * Rows are flush to the card edge so their dividers span its full width, which
 * is why this renders no padding of its own around them.
 */
export function SettingGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="border-b border-border px-6 py-4">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  )
}

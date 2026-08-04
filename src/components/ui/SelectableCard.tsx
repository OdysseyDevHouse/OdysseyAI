'use client'

import type { ReactNode } from 'react'

/**
 * A large, clickable choice tile — a checkbox or radio with a title, an
 * explanation and optional extras, used where the choice matters enough to
 * deserve describing rather than being a bare label in a list.
 *
 * The whole tile is the control: it renders a real <input> so keyboard and
 * screen-reader behaviour, and form submission, work exactly as they would for
 * a plain radio. `<label>` wrapping the input is what makes the tile clickable
 * without a click handler.
 */

export function SelectableCard({
  name,
  value,
  type = 'radio',
  title,
  description,
  checked,
  defaultChecked,
  onChange,
  badge,
  footer,
  disabled,
}: {
  name: string
  value: string
  /** 'radio' for one-of-many (the default), 'checkbox' for independent flags. */
  type?: 'radio' | 'checkbox'
  title: string
  description?: string
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (value: string) => void
  /** Small marker beside the title, e.g. an availability note. */
  badge?: ReactNode
  /** Action shown at the foot of the tile, e.g. a link to a setup screen. */
  footer?: ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={`flex flex-col gap-2 rounded-card border p-4 transition ${
        checked
          ? 'border-brand bg-brand-soft'
          : 'border-border bg-surface hover:border-border-strong'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
    >
      <div className="flex items-start gap-2.5">
        <input
          type={type}
          name={name}
          value={value}
          checked={checked}
          defaultChecked={defaultChecked}
          disabled={disabled}
          onChange={(e) => e.target.checked && onChange?.(value)}
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
            {title}
            {badge}
          </span>
          {description && <span className="text-xs text-muted">{description}</span>}
        </div>
      </div>
      {footer && <div className="pl-6.5">{footer}</div>}
    </label>
  )
}

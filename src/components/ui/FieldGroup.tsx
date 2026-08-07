import type { ReactNode } from 'react'

/**
 * FieldGroup — a titled cluster of related fields inside one Card: the
 * mechanism behind odyssey-craft's "group by what the user is doing". Use it
 * when a form's sections are too small to each deserve their own Card but too
 * distinct to run together in one column.
 *
 * Forms were hand-rolling this as `rounded-card border p-4` plus a bold <p>;
 * this is the one spelling, with the title wired up for screen readers.
 */
export function FieldGroup({
  title,
  hint,
  children,
  className = '',
}: {
  title: string
  /** One line on what this cluster is for. */
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <fieldset className={`rounded-card border border-border p-4 ${className}`}>
      <legend className="-mx-1 px-1 text-sm font-medium text-ink">{title}</legend>
      {hint && <p className="mb-3 text-xs text-muted">{hint}</p>}
      <div className={`flex flex-col gap-4 ${hint ? '' : 'mt-1'}`}>{children}</div>
    </fieldset>
  )
}

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
  step,
  children,
  className = '',
}: {
  title: string
  /** One line on what this cluster is for. */
  hint?: string
  /**
   * A step NUMBER beside the title, for a form that is genuinely a sequence:
   * pick what to write, then how to work it out, then who it applies to.
   *
   * Only for a form whose groups must be read in order — a numbered badge on a
   * set of independent sections promises a sequence that is not there, and the
   * user then hunts for the step they are "supposed" to be on. Most forms want
   * the plain title.
   */
  step?: number
  children: ReactNode
  className?: string
}) {
  return (
    <fieldset className={`rounded-card border border-border p-4 ${className}`}>
      {/* The badge sits INSIDE the legend rather than beside it, so the number
          is read out with the title and the group still announces as one thing. */}
      <legend className="-mx-1 flex items-center gap-2 px-1 text-sm font-medium text-ink">
        {step !== undefined && (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-brand-soft text-xs font-semibold text-brand"
            aria-hidden
          >
            {step}
          </span>
        )}
        {title}
      </legend>
      {hint && (
        /* Indented to the title's text when there is a badge, so the hint reads
           as belonging to the heading rather than to the number. */
        <p className={`mb-3 text-xs text-muted ${step !== undefined ? 'ps-8' : ''}`}>{hint}</p>
      )}
      <div className={`flex flex-col gap-4 ${hint ? '' : 'mt-1'} ${step !== undefined ? 'ps-8' : ''}`}>
        {children}
      </div>
    </fieldset>
  )
}

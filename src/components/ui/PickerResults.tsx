'use client'

import type { ReactNode } from 'react'

/**
 * PickerResults — the list of matches under a type-ahead search box.
 *
 * The shape that appears wherever something is chosen by typing rather than
 * from a dropdown: adding a product to a contract or a quote, attaching a
 * customer to a sale, picking an account. Each result is a full-width button
 * with an identity on the left and a figure on the right.
 *
 * A result row is NOT a <Button>. It has no variant, fills its container, and
 * reads as a list rather than as a control — but it is still a real <button>
 * so keyboard focus and Enter work. That combination is why it belongs in the
 * kit rather than being hand-rolled at each call site with slightly different
 * padding every time.
 *
 * Renders nothing when there are no results: an empty bordered box under a
 * search field reads as "broken", not as "nothing matched". Say that above the
 * field instead, where the user is already looking.
 */

export type PickerResult = {
  /** Stable key — usually the record's id. */
  key: string | number
  /** The main line: what the thing is called. */
  label: string
  /** Small print under the label — a code, a category, a stock figure. */
  meta?: ReactNode
  /** Right-aligned figure, usually a price. Gets tabular figures. */
  trailing?: ReactNode
  disabled?: boolean
}

export function PickerResults({
  results,
  onPick,
  className = '',
}: {
  results: readonly PickerResult[]
  onPick: (key: string | number) => void
  className?: string
}) {
  if (results.length === 0) return null

  return (
    <div
      className={`mt-2 overflow-hidden rounded-control border border-border ${className}`}
      role="listbox"
    >
      {results.map((result) => (
        <button
          key={result.key}
          type="button"
          role="option"
          aria-selected={false}
          disabled={result.disabled}
          onClick={() => onPick(result.key)}
          className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{result.label}</span>
            {result.meta ? (
              <span className="mt-0.5 block truncate text-xs text-muted">{result.meta}</span>
            ) : null}
          </span>
          {result.trailing ? (
            <span className="numeric shrink-0 text-sm text-ink-2">{result.trailing}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

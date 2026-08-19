'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from './icons'

/**
 * The label of a table row that folds a detail row open underneath it.
 *
 * ── WHY NOT Accordion ────────────────────────────────────────────────────
 *
 * `Accordion` is a card: it owns a border, a rounded surface and a shadow, and
 * it sits in a flex column of siblings. Dropping one into a `<td>` puts a card
 * inside a cell, which draws a second box around a row that already has its own
 * hairline and immediately looks like a different table.
 *
 * This is the same interaction stripped to what a table row can wear — a
 * chevron and a label, in the first cell, with the row's own hover doing the
 * rest. The expanded content is a sibling `<tr>` the caller renders, not a
 * child of this, because a table row cannot contain another row.
 *
 * ── WHY NOT Button ───────────────────────────────────────────────────────
 *
 * A `Button` is a thing you press to make something happen. This makes nothing
 * happen: it reveals detail that is already on the page, and reads as the row's
 * name rather than as a control sitting beside it. Given a button's height,
 * padding and weight it would be the loudest thing in a table whose job is to
 * be scanned — and every row in the column would then have to look like one.
 *
 * ── DISABLED IS STILL A LABEL ────────────────────────────────────────────
 *
 * A signed-off record has nothing to fold, but the row still needs its name.
 * Disabled therefore drops the affordance — no hover, no pointer — while
 * keeping the text exactly where it was, so a finalised table is the same shape
 * as the one somebody was typing into a minute ago.
 */
export function RowDisclosure({
  label,
  hint,
  open,
  onToggle,
  disabled = false,
}: {
  label: string
  /** A quiet note beside the label — what folding it would do, or what is
      under it. Shown at the same size as a table hint, never as loud as the
      label itself. */
  hint?: ReactNode
  open: boolean
  onToggle: () => void
  /** No fold available — renders as plain row text. */
  disabled?: boolean
}) {
  return (
    // Pulled back by its own padding so the label sits on the column's left
    // edge, in line with every other cell in the column. Without it a row with
    // a chevron is indented against the rows without one.
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      disabled={disabled}
      /* `max-w-full` and a truncating hint: in a tight cell — a till dialog's
         count column, say — an untruncated hint pushes the button past its own
         column and lands on the figure in the next one. The label is what must
         survive, so the hint is the half that gives way. */
      className="-mx-1.5 flex max-w-full items-center gap-1.5 rounded-control px-1.5 py-0.5 text-left transition hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
    >
      {/* Rotated rather than swapped for an up-chevron: the same glyph turning
          is read as one control changing state, where two different arrows read
          as two different buttons. Hidden when there is nothing to fold. */}
      {!disabled && (
        <ChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      )}
      <span className="shrink-0 font-medium text-ink">{label}</span>
      {hint && <span className="truncate text-xs text-muted">{hint}</span>}
    </button>
  )
}

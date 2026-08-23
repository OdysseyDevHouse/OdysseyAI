'use client'

import { TouchRow } from './TouchRow'
import { Field, Textarea } from './Field'
import { Info } from './icons'

/**
 * Choosing from a short list of coded reasons, at a till or on a form.
 *
 * ── WHY NOT A SELECT ──────────────────────────────────────────────────────
 *
 * A dropdown hides its options until tapped, costs two taps instead of one, and
 * puts a native picker over the screen at the moment a cashier has a customer
 * waiting. These lists are deliberately short — six or seven — so they fit
 * open, and a list you can see is a list somebody reads rather than one they
 * tap the top of.
 *
 * ── WHY THE NOTE IS PART OF THIS COMPONENT ────────────────────────────────
 *
 * The note is only offered when the chosen reason says the code does not speak
 * for itself, so it appears and disappears as the selection changes. Keeping
 * that rule here means every screen that picks a reason obeys it, rather than
 * three call sites each deciding when to show a box.
 */

export type PickableReason = {
  id: number
  code: string
  name: string
  allowsNote: boolean
}

export function ReasonPicker({
  reasons,
  value,
  note,
  onChange,
  onNoteChange,
  label = 'Reason',
  hint,
  noteLabel = 'Anything to add?',
  notePlaceholder = 'Optional — what happened this time',
  error,
  touch = false,
  disabled = false,
}: {
  reasons: PickableReason[]
  /** The chosen reason id, or null while nothing is picked. */
  value: number | null
  note: string
  onChange: (id: number) => void
  onNoteChange: (note: string) => void
  label?: string
  hint?: string
  noteLabel?: string
  notePlaceholder?: string
  error?: string
  /**
   * The till dressing: a chevron on every row, and the hint carried by an info
   * glyph rather than sitting as loose grey text.
   *
   * Off by default, which is right on a back-office form. A chevron there says
   * "this opens something" and these rows only choose; the hint is one of a
   * column of hints under a column of fields, and a glyph on one of them makes
   * that one look like a warning. On a TILL the list is the full width of a
   * dialog with a lot of white to the right of the words, and the chevron is
   * what makes each strip read as a KEY — the same affordance every other touch
   * row in the POS carries. The hint likewise stands alone down there, so the
   * glyph marks it as a note about the act rather than more of the question.
   */
  touch?: boolean
  disabled?: boolean
}) {
  const chosen = reasons.find((r) => r.id === value) ?? null

  // A site can retire every reason on a list. Saying so beats rendering an empty
  // box the cashier cannot get past without knowing why.
  if (reasons.length === 0) {
    return (
      <Field label={label} error="No reasons are set up. An owner can add them in Setup.">
        <div />
      </Field>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* In touch dress the hint is rendered below rather than handed to Field,
          because it needs a glyph beside it and Field's hint is a string. An
          `error` still goes through Field: it must flip the label's own state,
          and it replaces the hint rather than joining it. */}
      <Field label={label} hint={touch ? undefined : hint} error={error}>
        <div className="flex flex-col gap-2">
          {reasons.map((reason) => (
            <TouchRow
              key={reason.id}
              title={reason.name}
              tone={reason.id === value ? 'active' : 'default'}
              showChevron={touch}
              disabled={disabled}
              onClick={() => onChange(reason.id)}
            />
          ))}
        </div>
      </Field>

      {/* Only for reasons whose code genuinely does not say enough. Rendering it
          always would train cashiers to skip a box that sometimes matters. */}
      {chosen?.allowsNote && (
        <Field label={noteLabel} hint="Optional.">
          <Textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={notePlaceholder}
            rows={2}
            disabled={disabled}
          />
        </Field>
      )}

      {/* Last, under the note rather than above it. The hint is about what
          happens to the WHOLE answer — that it is filed against the till and
          reported on — so it belongs after everything being answered. Sitting
          between the list and the note box it read as a footnote to the list
          and pushed the note away from the choice that summoned it. */}
      {touch && hint && !error && (
        <p className="flex items-start gap-2 text-xs text-muted">
          <Info size={14} className="mt-px shrink-0" />
          <span>{hint}</span>
        </p>
      )}
    </div>
  )
}

'use client'

import { TouchRow } from './TouchRow'
import { Field, Textarea } from './Field'

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
      <Field label={label} hint={hint} error={error}>
        <div className="flex flex-col gap-2">
          {reasons.map((reason) => (
            <TouchRow
              key={reason.id}
              title={reason.name}
              tone={reason.id === value ? 'active' : 'default'}
              showChevron={false}
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
    </div>
  )
}

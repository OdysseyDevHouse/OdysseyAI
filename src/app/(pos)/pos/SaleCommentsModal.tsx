'use client'

import { useEffect, useState } from 'react'
import { Button, Field, Icons, Input, Modal, Select } from '@/components/ui'
import { validateFieldValue, type CustomFieldType } from '@/lib/customFieldModel'

/**
 * The questions a sale has to answer before it can be paid for.
 *
 * ── WHY THIS STANDS BETWEEN THE PAD AND THE POST ──────────────────────────
 *
 * The shop defines these under Setup › Custom fields › Sales, and a tender type
 * carrying `asksCustomComments` is what makes the till ask them. It appears
 * AFTER the cashier has chosen how to pay and BEFORE the sale posts, which is
 * the only moment both facts are known: which tender was used, and that the
 * money has not yet changed hands.
 *
 * ── ASKED ONCE, WHATEVER THE SPLIT ────────────────────────────────────────
 *
 * A basket settled half on Account and half on Cash asks once, for the whole
 * set, if EITHER tender wants comments. That is a property of the flag rather
 * than of this component — see 242, which chose a per-tender flag over a
 * per-tender question set precisely so this dialog can never have to decide
 * whose questions win.
 *
 * ── AND WHY CANCELLING IS NOT A REFUSAL ───────────────────────────────────
 *
 * Closing this returns to the tender pad with the basket intact. A cashier who
 * opens it and realises they picked the wrong payment method must be able to
 * back out — the alternative is a dialog that traps a sale until somebody
 * invents answers, and invented answers are worse than none.
 */

export type SaleCommentField = {
  fieldId: number
  code: string
  name: string
  hint: string | null
  fieldType: CustomFieldType
  options: string[]
  unit: string | null
  isRequired: boolean
}

export default function SaleCommentsModal({
  open,
  fields,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean
  fields: SaleCommentField[]
  pending: boolean
  onCancel: () => void
  /** The answers, keyed by field id. Only non-empty ones are sent. */
  onConfirm: (values: Record<number, string>) => void
}) {
  const [values, setValues] = useState<Record<number, string>>({})

  /* Cleared each time it opens. These belong to ONE sale, and a previous
     customer's answers appearing under the next one's name is the failure this
     avoids — the dialog's children do not unmount when it closes. */
  useEffect(() => {
    if (open) setValues({})
  }, [open])

  const set = (id: number, value: string) =>
    setValues((current) => ({ ...current, [id]: value }))

  /*
   * What is wrong with the answers so far.
   *
   * The SAME validator the setup screen and the server use — a till that
   * accepted a date the action then refused would strand a sale at the pad with
   * the customer waiting, which is the worst place to discover a disagreement
   * about what a valid value is.
   */
  const problems = fields
    .map((f) => {
      const raw = (values[f.fieldId] ?? '').trim()
      if (f.isRequired && raw === '') return `${f.name} is required.`
      if (raw === '') return null
      /* Already names the field in its message, so it is shown verbatim. */
      return validateFieldValue(f, raw)
    })
    .filter((p): p is string => p !== null)

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="A few details before we finish"
      size="md"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(values)}
            disabled={pending || problems.length > 0}
          >
            <Icons.Check size={15} />
            {pending ? 'Finishing…' : 'Finish the sale'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          This payment method asks for these before the sale can be completed.
        </p>

        {fields.map((f) => {
          const value = values[f.fieldId] ?? ''
          return (
            <Field
              key={f.fieldId}
              label={f.isRequired ? `${f.name} *` : f.name}
              hint={f.hint ?? undefined}
            >
              {f.fieldType === 'yesno' ? (
                <Select value={value} onChange={(e) => set(f.fieldId, e.target.value)}>
                  <option value="">Not answered</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              ) : f.fieldType === 'list' ? (
                <Select value={value} onChange={(e) => set(f.fieldId, e.target.value)}>
                  <option value="">Not chosen</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={f.fieldType === 'date' ? 'date' : 'text'}
                  inputMode={f.fieldType === 'number' ? 'decimal' : undefined}
                  value={value}
                  onChange={(e) => set(f.fieldId, e.target.value)}
                  maxLength={500}
                  placeholder={f.fieldType === 'number' && f.unit ? f.unit : undefined}
                  /* The first field takes focus, so a keyboard-only counter can
                     type straight into it without reaching for the screen. */
                  autoFocus={f.fieldId === fields[0]?.fieldId}
                />
              )}
            </Field>
          )
        })}

        {/* Only once something has been typed: a list of "X is required" above
            an untouched form is scolding somebody for not having started. */}
        {problems.length > 0 && Object.keys(values).length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

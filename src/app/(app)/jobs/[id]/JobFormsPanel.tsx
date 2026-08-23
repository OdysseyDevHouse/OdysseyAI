'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Icons,
  Input,
  NumberInput,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { saveFormAction } from '../actions'
import {
  isFieldVisible,
  parseMultiSelect,
  takesAnswer,
  validateAnswer,
  type FormAnswer,
  type FormField,
} from '@/lib/jobFormModel'

/**
 * Filling in a form on a job (§24).
 *
 * ── ONE FORM AT A TIME ─────────────────────────────────────────────────────
 *
 * The card lists what this job is asked for and opens ONE. A job with four
 * forms rendering all four expanded is a page nobody can find their place in,
 * and the technician is holding a phone.
 *
 * ── CONDITIONS ARE EVALUATED HERE AND AGAIN ON THE SERVER ──────────────────
 *
 * `isFieldVisible` is the same pure function `saveResponse` runs, so a field
 * hidden on screen is a field the server also treats as unasked. That matters
 * for required fields: "why not?" must not block a submission when the answer
 * was Yes, and the two halves agreeing is what makes that safe rather than a
 * client-side courtesy the action would override.
 *
 * ── SAVE AND SUBMIT ARE DIFFERENT PROMISES ─────────────────────────────────
 *
 * Save records what has been filled in so far and validates nothing. Submit
 * validates everything and stamps the response, which is what the close gate
 * reads. Somebody halfway up a ladder pressing Save must never be told the
 * reading they have not taken yet is required.
 */

export type JobFormSummary = {
  formId: number
  formName: string
  isRequired: boolean
  version: number
  versionId: number | null
  responseId: number | null
  submittedAt: string | null
  respondentName: string
}

export type OpenForm = {
  formId: number
  responseId: number | null
  fields: FormField[]
  answers: FormAnswer[]
}

export default function JobFormsPanel({
  jobId,
  jobClosed,
  canEdit,
  forms,
  loadForm,
}: {
  jobId: number
  jobClosed: boolean
  canEdit: boolean
  forms: JobFormSummary[]
  /** Fetches one form's shape and any answers already saved. */
  loadForm: (formId: number) => Promise<OpenForm | null>
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [openForm, setOpenForm] = useState<OpenForm | null>(null)
  const [draft, setDraft] = useState<Map<number, FormAnswer>>(new Map())

  if (forms.length === 0) return null

  const editable = canEdit && !jobClosed

  function open(formId: number) {
    start(async () => {
      const loaded = await loadForm(formId)
      if (!loaded) {
        toast.error('That form could not be opened.')
        return
      }
      setOpenForm(loaded)
      setDraft(new Map(loaded.answers.map((a) => [a.fieldId, a])))
    })
  }

  function setAnswer(fieldId: number, change: Partial<FormAnswer>) {
    setDraft((prev) => {
      const next = new Map(prev)
      next.set(fieldId, { ...(next.get(fieldId) ?? { fieldId }), ...change, fieldId })
      return next
    })
  }

  function save(submit: boolean) {
    if (!openForm) return
    start(async () => {
      const result = await saveFormAction({
        jobId,
        formId: openForm.formId,
        responseId: openForm.responseId,
        answers: [...draft.values()],
        submit,
      })
      if (result.ok) {
        toast.success(submit ? 'Form submitted.' : 'Saved.')
        setOpenForm(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Forms"
        description="What this job asks to be recorded. A required one has to be submitted before the job can close."
      />
      <CardBody>
        {openForm === null ? (
          <div className="flex flex-col gap-2">
            {forms.map((f) => (
              <div
                key={f.formId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{f.formName}</span>
                  {f.isRequired && <Badge tone="warning">Required</Badge>}
                  {f.submittedAt ? (
                    <Badge tone="success">Done</Badge>
                  ) : f.responseId !== null ? (
                    <Badge tone="neutral">Started</Badge>
                  ) : null}
                  {f.versionId === null && <Badge tone="danger">Not published</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {f.submittedAt && f.respondentName && (
                    <span className="text-xs text-muted">by {f.respondentName}</span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending || f.versionId === null}
                    onClick={() => open(f.formId)}
                  >
                    {f.submittedAt ? 'View' : editable ? 'Fill in' : 'View'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <FormBody
            form={openForm}
            draft={draft}
            editable={editable}
            pending={pending}
            onChange={setAnswer}
            onClose={() => setOpenForm(null)}
            onSave={save}
          />
        )}
      </CardBody>
    </Card>
  )
}

function FormBody({
  form,
  draft,
  editable,
  pending,
  onChange,
  onClose,
  onSave,
}: {
  form: OpenForm
  draft: Map<number, FormAnswer>
  editable: boolean
  pending: boolean
  onChange: (fieldId: number, change: Partial<FormAnswer>) => void
  onClose: () => void
  onSave: (submit: boolean) => void
}) {
  /*
   * Visibility is recomputed on every keystroke, because answering the field a
   * condition watches is exactly what makes the dependent one appear. Memoised
   * on the draft so a long form does not re-walk itself per input.
   */
  const visible = useMemo(
    () => form.fields.filter((f) => isFieldVisible(f, draft)),
    [form.fields, draft],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          ← Back to the list
        </Button>
        {editable && (
          <div className="flex gap-1.5">
            <Button variant="ghost" onClick={() => onSave(false)} disabled={pending}>
              Save for now
            </Button>
            <Button onClick={() => onSave(true)} disabled={pending}>
              {pending ? 'Working…' : 'Submit'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {visible.map((field) => {
          const answer = draft.get(field.id)
          // Shown as somebody types, from the SAME function the action runs.
          const problem = editable ? validateAnswer(field, answer) : null
          return (
            <FieldRow
              key={field.id}
              field={field}
              answer={answer}
              problem={problem}
              editable={editable}
              pending={pending}
              onChange={onChange}
            />
          )
        })}
      </div>
    </div>
  )
}

function FieldRow({
  field,
  answer,
  problem,
  editable,
  pending,
  onChange,
}: {
  field: FormField
  answer: FormAnswer | undefined
  problem: string | null
  editable: boolean
  pending: boolean
  onChange: (fieldId: number, change: Partial<FormAnswer>) => void
}) {
  const disabled = !editable || pending

  if (field.fieldType === 'heading') {
    return (
      <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted">{field.label}</p>
    )
  }
  if (field.fieldType === 'page_break') {
    return <hr className="border-border" />
  }

  const label = field.isRequired ? `${field.label} *` : field.label
  // The problem is shown only once something has been entered, so a form does
  // not open covered in red about fields nobody has reached yet.
  const showProblem = problem !== null && answer !== undefined

  const body = () => {
    switch (field.fieldType) {
      case 'long_text':
        return (
          <Textarea
            value={answer?.text ?? ''}
            disabled={disabled}
            rows={3}
            onChange={(e) => onChange(field.id, { text: e.target.value })}
          />
        )
      case 'number':
      case 'measure':
        return (
          <div className="flex items-center gap-2">
            <NumberInput
              value={answer?.number ?? ''}
              disabled={disabled}
              onChange={(e) =>
                onChange(field.id, {
                  number: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              className="numeric max-w-[10rem]"
            />
            {field.unit && <span className="text-sm text-muted">{field.unit}</span>}
          </div>
        )
      case 'date':
      case 'time':
        return (
          <Input
            type={field.fieldType === 'date' ? 'date' : 'time'}
            value={answer?.date ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(field.id, { date: e.target.value })}
            className="max-w-[12rem]"
          />
        )
      case 'yesno':
      case 'checkbox':
        return (
          <Checkbox
            checked={answer?.bool === true}
            disabled={disabled}
            onChange={(e) => onChange(field.id, { bool: e.target.checked })}
            label={field.fieldType === 'yesno' ? 'Yes' : 'Tick to confirm'}
          />
        )
      case 'dropdown':
      case 'choice':
        return (
          <Select
            value={answer?.text ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(field.id, { text: e.target.value })}
            className="max-w-[16rem]"
          >
            <option value="">Choose one</option>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        )
      case 'multi_select': {
        // Stored as a JSON array in the shared text column — see the model.
        const chosen = parseMultiSelect(answer?.text)
        return (
          <div className="flex flex-col gap-1">
            {field.options.map((o) => (
              <Checkbox
                key={o}
                checked={chosen.includes(o)}
                disabled={disabled}
                label={o}
                onChange={(e) =>
                  onChange(field.id, {
                    text: JSON.stringify(
                      e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o),
                    ),
                  })
                }
              />
            ))}
          </div>
        )
      }
      /*
       * file, photo, signature, gps and record all need machinery this card
       * does not have — an upload, a pad, the device's location, a searchable
       * picker. Each is a screen of its own and none of them belongs behind a
       * half-built control that looks ready.
       *
       * They render as a plain note rather than a broken input, because a form
       * that silently omits a field its builder added would be a form somebody
       * thinks they completed.
       */
      default:
        return (
          <p className="text-sm text-muted">
            This kind of answer is captured on the mobile app.
          </p>
        )
    }
  }

  return (
    <Field label={label} hint={field.hint ?? undefined} error={showProblem ? problem : undefined}>
      {body()}
    </Field>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { publishAction, saveDraftAction, startDraftAction } from '../actions'
import {
  FORM_FIELD_TYPES,
  FIELD_TYPE_LABEL,
  RECORD_KINDS,
  RECORD_KIND_LABEL,
  TYPES_WITH_OPTIONS,
  takesAnswer,
  type FormField,
  type FormFieldType,
} from '@/lib/jobFormModel'

/**
 * The field editor.
 *
 * ── EVERYTHING IS LOCAL UNTIL SAVE ─────────────────────────────────────────
 *
 * Adding, removing and reordering happen in React state and reach the server as
 * one whole-array save. That matches what `saveDraft` expects — it replaces
 * every row rather than applying a diff — and it means somebody can rearrange
 * six fields and change their mind without six round trips, each of which would
 * have to be undoable.
 *
 * ── CONDITIONS TRAVEL AS POSITIONS ─────────────────────────────────────────
 *
 * A new field has no id, so a condition on it cannot name one. The wire format
 * is the INDEX of the field depended on, resolved to a real id by the server
 * after the insert. That is also why a condition may only point backwards: the
 * select below offers the fields above this one and nothing else.
 */

type Draft = {
  /** Stable across reorders, so React keys and the condition select behave. */
  key: string
  fieldType: FormFieldType
  label: string
  hint: string
  unit: string
  recordKind: string
  options: string
  isRequired: boolean
  minValue: string
  maxValue: string
  maxLength: string
  pattern: string
  /** The key of the field this depends on, or '' for none. */
  showIfKey: string
  showIfValue: string
}

let seq = 0
const nextKey = () => `f${seq++}`

function toDraft(field: FormField, byId: Map<number, string>): Draft {
  return {
    key: byId.get(field.id) ?? nextKey(),
    fieldType: field.fieldType,
    label: field.label,
    hint: field.hint ?? '',
    unit: field.unit ?? '',
    recordKind: field.recordKind ?? '',
    options: field.options.join('\n'),
    isRequired: field.isRequired,
    minValue: field.minValue === null ? '' : String(field.minValue),
    maxValue: field.maxValue === null ? '' : String(field.maxValue),
    maxLength: field.maxLength === null ? '' : String(field.maxLength),
    pattern: field.pattern ?? '',
    showIfKey: field.showIfFieldId === null ? '' : (byId.get(field.showIfFieldId) ?? ''),
    showIfValue: field.showIfValue ?? '',
  }
}

const blank = (): Draft => ({
  key: nextKey(),
  fieldType: 'short_text',
  label: '',
  hint: '',
  unit: '',
  recordKind: '',
  options: '',
  isRequired: false,
  minValue: '',
  maxValue: '',
  maxLength: '',
  pattern: '',
  showIfKey: '',
  showIfValue: '',
})

export default function BuilderClient({
  formId,
  formName,
  versionId,
  version,
  isDraft,
  fields,
}: {
  formId: number
  formName: string
  versionId: number | null
  version: number
  isDraft: boolean
  fields: FormField[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [drafts, setDrafts] = useState<Draft[]>(() => {
    // Keys are assigned once, on first render, and then travel with the row.
    // Deriving them from the array index would make every reorder look like a
    // delete-and-insert to React and to the condition select.
    const byId = new Map(fields.map((f) => [f.id, nextKey()]))
    return fields.map((f) => toDraft(f, byId))
  })
  const [open, setOpen] = useState<string | null>(null)

  const editable = isDraft && versionId !== null

  function patch(key: string, change: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...change } : d)))
  }

  function add() {
    const field = blank()
    setDrafts((prev) => [...prev, field])
    setOpen(field.key)
  }

  function remove(key: string) {
    setDrafts((prev) =>
      prev
        .filter((d) => d.key !== key)
        // A condition pointing at a field that has just gone becomes no
        // condition. Leaving it would send an index the server refuses, and the
        // person would have to work out which of six rows was to blame.
        .map((d) => (d.showIfKey === key ? { ...d, showIfKey: '', showIfValue: '' } : d)),
    )
  }

  function move(key: string, by: number) {
    setDrafts((prev) => {
      const i = prev.findIndex((d) => d.key === key)
      const j = i + by
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      /*
       * A move can put a field ABOVE the one it depends on, which the server
       * refuses. Clearing the condition here is the honest fix: the alternative
       * is refusing the move, which leaves somebody dragging a row that will not
       * go and no explanation on screen.
       */
      return next.map((d, idx) => {
        if (!d.showIfKey) return d
        const target = next.findIndex((x) => x.key === d.showIfKey)
        return target >= 0 && target < idx ? d : { ...d, showIfKey: '', showIfValue: '' }
      })
    })
  }

  function save(thenPublish: boolean) {
    if (versionId === null) return
    start(async () => {
      const payload = drafts.map((d) => ({
        fieldType: d.fieldType,
        label: d.label,
        hint: d.hint || null,
        unit: d.unit || null,
        recordKind: d.recordKind || null,
        options: d.options
          .split('\n')
          .map((o) => o.trim())
          .filter(Boolean),
        isRequired: d.isRequired,
        minValue: d.minValue === '' ? null : Number(d.minValue),
        maxValue: d.maxValue === '' ? null : Number(d.maxValue),
        maxLength: d.maxLength === '' ? null : Number(d.maxLength),
        pattern: d.pattern || null,
        showIfIndex: d.showIfKey ? drafts.findIndex((x) => x.key === d.showIfKey) : null,
        showIfValue: d.showIfValue || null,
      }))

      const saved = await saveDraftAction(formId, versionId, payload)
      if (!saved.ok) {
        toast.error(saved.error)
        return
      }
      if (!thenPublish) {
        toast.success('Draft saved.')
        router.refresh()
        return
      }
      const published = await publishAction(formId, versionId)
      if (published.ok) {
        toast.success(`${formName} is live.`)
        router.refresh()
      } else {
        toast.error(published.error)
      }
    })
  }

  function beginDraft() {
    start(async () => {
      const result = await startDraftAction(formId)
      if (result.ok) router.refresh()
      else toast.error(result.error)
    })
  }

  return (
    <Card>
      <CardHeader
        title={isDraft ? 'Fields' : `Version ${version}`}
        description={
          editable
            ? 'Nothing is asked of anybody until this is published.'
            : 'Published, so it cannot be changed. Start a draft to make the next version.'
        }
        action={
          editable ? (
            <div className="flex gap-1.5">
              <Button variant="ghost" onClick={add} disabled={pending}>
                Add a field
              </Button>
              <Button variant="ghost" onClick={() => save(false)} disabled={pending}>
                Save draft
              </Button>
              <Button onClick={() => save(true)} disabled={pending}>
                {pending ? 'Working…' : 'Publish'}
              </Button>
            </div>
          ) : (
            <Button onClick={beginDraft} disabled={pending}>
              Start a draft
            </Button>
          )
        }
      />
      <CardBody>
        {drafts.length === 0 ? (
          <EmptyState
            icon={<Icons.FileText size={20} />}
            title="No fields yet"
            hint="A form with no fields cannot be published — there would be nothing to fill in."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {drafts.map((d, index) => {
              const expanded = open === d.key
              const structural = !takesAnswer(d.fieldType)
              const above = drafts.slice(0, index)

              return (
                <div key={d.key} className="rounded-card border border-border">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="w-6 text-xs text-muted">{index + 1}</span>
                    <Input
                      value={d.label}
                      disabled={!editable || pending}
                      onChange={(e) => patch(d.key, { label: e.target.value })}
                      placeholder="What is being asked"
                      className="min-w-[12rem] flex-1"
                    />
                    <Select
                      value={d.fieldType}
                      disabled={!editable || pending}
                      onChange={(e) =>
                        patch(d.key, { fieldType: e.target.value as FormFieldType })
                      }
                      className="w-[12rem]"
                    >
                      {FORM_FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {FIELD_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </Select>
                    {d.isRequired && !structural && <Badge tone="warning">Required</Badge>}
                    {d.showIfKey && <Badge tone="brand">Conditional</Badge>}
                    {editable && (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => move(d.key, -1)} disabled={pending || index === 0}>
                          ↑
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => move(d.key, 1)} disabled={pending || index === drafts.length - 1}>
                          ↓
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setOpen(expanded ? null : d.key)} disabled={pending}>
                          {expanded ? 'Done' : 'Settings'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => remove(d.key)} disabled={pending}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>

                  {expanded && editable && (
                    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                      <Field label="Hint" hint="Shown under the question.">
                        <Input
                          value={d.hint}
                          onChange={(e) => patch(d.key, { hint: e.target.value })}
                          maxLength={190}
                        />
                      </Field>

                      {/* A heading and a page break take no answer, so every
                          setting below would be a control that does nothing. */}
                      {!structural && (
                        <div className="flex flex-col gap-1">
                          <Checkbox
                            checked={d.isRequired}
                            onChange={(e) => patch(d.key, { isRequired: e.target.checked })}
                            label="Must be answered"
                          />
                          <span className="text-xs text-muted">
                            A required field behind a condition only counts when the condition is
                            met.
                          </span>
                        </div>
                      )}

                      {d.fieldType === 'measure' && (
                        <Field label="Unit" hint="kPa, °C, mm. Shown beside the box.">
                          <Input
                            value={d.unit}
                            onChange={(e) => patch(d.key, { unit: e.target.value })}
                            className="max-w-[8rem]"
                            maxLength={20}
                          />
                        </Field>
                      )}

                      {(d.fieldType === 'number' || d.fieldType === 'measure') && (
                        <div className="flex flex-wrap gap-3">
                          <Field label="Not below">
                            <NumberInput
                              value={d.minValue}
                              onChange={(e) => patch(d.key, { minValue: e.target.value })}
                              className="numeric max-w-[8rem]"
                            />
                          </Field>
                          <Field label="Not above">
                            <NumberInput
                              value={d.maxValue}
                              onChange={(e) => patch(d.key, { maxValue: e.target.value })}
                              className="numeric max-w-[8rem]"
                            />
                          </Field>
                        </div>
                      )}

                      {TYPES_WITH_OPTIONS.includes(d.fieldType) && (
                        <Field label="The choices" hint="One per line.">
                          <Textarea
                            value={d.options}
                            onChange={(e) => patch(d.key, { options: e.target.value })}
                            rows={4}
                          />
                        </Field>
                      )}

                      {d.fieldType === 'record' && (
                        <Field label="Which file to search">
                          <Select
                            value={d.recordKind}
                            onChange={(e) => patch(d.key, { recordKind: e.target.value })}
                            className="max-w-[14rem]"
                          >
                            <option value="">Choose one</option>
                            {RECORD_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {RECORD_KIND_LABEL[k]}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      )}

                      {(d.fieldType === 'short_text' || d.fieldType === 'long_text') && (
                        <div className="flex flex-wrap gap-3">
                          <Field label="Longest allowed">
                            <NumberInput
                              value={d.maxLength}
                              onChange={(e) => patch(d.key, { maxLength: e.target.value })}
                              className="numeric max-w-[8rem]"
                            />
                          </Field>
                          <Field
                            label="Must match"
                            hint="A pattern. Left blank, anything is accepted."
                          >
                            <Input
                              value={d.pattern}
                              onChange={(e) => patch(d.key, { pattern: e.target.value })}
                              className="max-w-[16rem]"
                              maxLength={190}
                            />
                          </Field>
                        </div>
                      )}

                      {/* Only fields ABOVE this one are offered: a condition
                          pointing downwards would let two fields hide each
                          other, and the server refuses it anyway. */}
                      {!structural && above.length > 0 && (
                        <div className="flex flex-wrap gap-3">
                          <Field label="Only ask this when" hint="Leave blank to always ask it.">
                            <Select
                              value={d.showIfKey}
                              onChange={(e) => patch(d.key, { showIfKey: e.target.value })}
                              className="max-w-[16rem]"
                            >
                              <option value="">Always</option>
                              {above
                                .filter((a) => takesAnswer(a.fieldType))
                                .map((a, i) => (
                                  <option key={a.key} value={a.key}>
                                    {a.label || `Field ${i + 1}`}
                                  </option>
                                ))}
                            </Select>
                          </Field>
                          {d.showIfKey && (
                            <Field label="…is" hint="For yes/no, type yes or no.">
                              <Input
                                value={d.showIfValue}
                                onChange={(e) => patch(d.key, { showIfValue: e.target.value })}
                                className="max-w-[12rem]"
                                maxLength={190}
                              />
                            </Field>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Select,
  TextLink,
  useToast,
} from '@/components/ui'
import type { CustomFieldValue } from '@/lib/site/customFields'
import { validateFieldValue, type CustomFieldEntity } from '@/lib/customFieldModel'

/**
 * The custom fields on ONE record, on the record's own screen.
 *
 * ── WHY THIS LIVES IN components/ AND NOT UNDER A ROUTE ────────────────────
 *
 * Because three routes mount it — a job, a customer, a piece of equipment — and
 * a copy under each would be three copies of the same eight input types. It
 * takes the entity as a prop and knows nothing else about its host.
 *
 * ── IT SAVES AS A FORM, NOT PER FIELD ──────────────────────────────────────
 *
 * One Save for the set rather than a write on every blur. A per-field save would
 * be eight round trips to fill in eight fields, and half of them landing is a
 * state the record should not be able to be in — the server writes the set in one
 * transaction precisely so it cannot.
 */
export default function CustomFieldsPanel({
  entity,
  entityId,
  fields,
  canEdit,
  onSave,
  title = 'Extra details',
}: {
  entity: CustomFieldEntity
  entityId: number
  fields: CustomFieldValue[]
  canEdit: boolean
  /** The host route's own action, so the capability checked is the host's. */
  onSave: (
    entity: CustomFieldEntity,
    entityId: number,
    values: { fieldId: number; value: string | null }[],
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  title?: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<number, string>>({})

  // Nothing defined for this kind of record: the panel renders NOTHING rather
  // than an empty card. A card saying "no custom fields" on every job of a
  // business that does not use them is pure noise.
  if (fields.length === 0) return null

  function begin() {
    const next: Record<number, string> = {}
    for (const f of fields) next[f.fieldId] = f.value ?? ''
    setDraft(next)
    setEditing(true)
  }

  const problems = fields
    .map((f) => validateFieldValue(f, draft[f.fieldId] ?? null))
    .filter((p): p is string => p !== null)

  function save() {
    start(async () => {
      const result = await onSave(
        entity,
        entityId,
        fields.map((f) => ({ fieldId: f.fieldId, value: draft[f.fieldId] ?? null })),
      )
      if (result.ok) {
        toast.success('Saved.')
        setEditing(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const missing = fields.filter(
    (f) => f.isRequired && (f.value === null || f.value.trim() === ''),
  )

  return (
    <Card>
      <CardHeader
        title={title}
        description="Fields this business added for itself."
        action={
          canEdit && !editing ? (
            <Button variant="secondary" onClick={begin} disabled={pending}>
              <Icons.Pencil size={15} />
              Edit
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {/* Reported, never enforced. A required custom field that BLOCKED a save
            would let somebody add a field on Monday and stop every technician
            closing a job on Tuesday. */}
        {missing.length > 0 && !editing && (
          <p className="mb-3 text-xs text-warning-ink">
            Not filled in: {missing.map((f) => f.name).join(', ')}.
          </p>
        )}

        {editing ? (
          <div className="flex flex-col gap-4">
            {fields.map((f) => {
              const value = draft[f.fieldId] ?? ''
              const problem = validateFieldValue(f, value)
              const set = (v: string) => setDraft((prev) => ({ ...prev, [f.fieldId]: v }))
              return (
                <Field
                  key={f.fieldId}
                  label={f.isRequired ? `${f.name} *` : f.name}
                  hint={f.hint ?? undefined}
                  error={problem ?? undefined}
                >
                  {f.fieldType === 'yesno' ? (
                    <Select value={value} onChange={(e) => set(e.target.value)} disabled={pending}>
                      <option value="">Not answered</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </Select>
                  ) : f.fieldType === 'list' ? (
                    <Select value={value} onChange={(e) => set(e.target.value)} disabled={pending}>
                      <option value="">Not chosen</option>
                      {/*
                       * A stored value that is no longer a choice is offered
                       * anyway, so opening the form does not silently blank it.
                       * The reconciliation screen reports these.
                       */}
                      {!f.options.includes(value) && value !== '' && (
                        <option value={value}>{value} (no longer a choice)</option>
                      )}
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
                      onChange={(e) => set(e.target.value)}
                      disabled={pending}
                      maxLength={500}
                      placeholder={f.fieldType === 'number' && f.unit ? f.unit : undefined}
                    />
                  )}
                </Field>
              )
            })}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending || problems.length > 0}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.fieldId} className="flex flex-col">
                <dt className="text-xs uppercase tracking-wide text-muted">
                  {f.name}
                  {f.isPublic && (
                    <>
                      {' '}
                      <Badge tone="brand">Customer sees it</Badge>
                    </>
                  )}
                </dt>
                <dd className="text-sm text-ink">
                  {f.value === null || f.value.trim() === '' ? (
                    <span className="text-faint">Not filled in</span>
                  ) : f.fieldType === 'yesno' ? (
                    f.value === 'yes' ? (
                      'Yes'
                    ) : (
                      'No'
                    )
                  ) : f.fieldType === 'number' && f.unit ? (
                    <span className="numeric">
                      {f.value} {f.unit}
                    </span>
                  ) : (
                    f.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {canEdit && !editing && (
          <p className="mt-3 text-xs text-muted">
            These are set up in{' '}
            <TextLink href="/setup/custom-fields">Setup &rsaquo; Custom fields</TextLink>.
          </p>
        )}
      </CardBody>
    </Card>
  )
}

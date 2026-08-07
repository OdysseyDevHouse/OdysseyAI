'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Close, Save } from '@/components/ui/icons'
import {
  Button,
  Callout,
  Field,
  FieldGroup,
  Input,
  NumberInput,
  Select,
  Switch,
  TILE_SWATCHES,
} from '@/components/ui'
import { saveDepartmentAction, type DepartmentFormState } from './actions'
import type { Department } from '@/lib/site/departments'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      <Save size={15} />
      {pending ? 'Saving…' : 'Save department'}
    </Button>
  )
}

export default function DepartmentForm({
  department,
  parentOptions,
  defaultParentId,
}: {
  department: Department | null
  /** Every department this one may sit under — already excludes itself and its
   *  own descendants, which would detach the branch from the tree. */
  parentOptions: { id: number; label: string }[]
  defaultParentId: number | null
}) {
  const [state, formAction] = useActionState<DepartmentFormState, FormData>(
    saveDepartmentAction,
    { error: null },
  )

  const [color, setColor] = useState(department?.color ?? '')
  const [active, setActive] = useState(department?.isActive ?? true)

  return (
    <form action={formAction} className="flex flex-col gap-5 p-5">
      {department && <input type="hidden" name="id" value={department.id} />}

      {state.error && (
        <Callout tone="danger" title="Could not save">
          {state.error}
        </Callout>
      )}

      <FieldGroup title="Identity" hint="What it is called and where it sits in the tree.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              name="name"
              defaultValue={department?.name ?? ''}
              required
              maxLength={120}
              autoFocus
            />
          </Field>

          <Field label="Code" hint="Optional — a short reference used in reports.">
            <Input name="code" defaultValue={department?.code ?? ''} maxLength={32} />
          </Field>
        </div>

        <Field label="Sits under">
          <Select
            name="parentId"
            defaultValue={department ? (department.parentId ?? '') : (defaultParentId ?? '')}
          >
            <option value="">&lt;Top level&gt;</option>
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGroup>

      <FieldGroup title="Presentation" hint="How it appears on tiles and in lists.">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Colour</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* data-kit-ok: "None" is an option in the swatch palette, so it is
                drawn as a swatch — a kit Button restyled to look like one would
                be worse than the swatch it is pretending not to be. */}
            <button
              data-kit-ok
              type="button"
              aria-label="No colour"
              aria-pressed={color === ''}
              onClick={() => setColor('')}
              className={`flex size-6 items-center justify-center rounded-pill border-2 bg-surface text-muted transition ${
                color === '' ? 'border-ink' : 'border-border-strong'
              }`}
            >
              <Close size={12} />
            </button>
            {TILE_SWATCHES.map((swatch) => (
              <button
                key={swatch.token}
                data-kit-ok
                type="button"
                aria-label={`Colour ${swatch.token}`}
                aria-pressed={color === swatch.token}
                onClick={() => setColor(swatch.token)}
                className={`size-6 rounded-pill border-2 transition ${swatch.className} ${
                  color === swatch.token ? 'border-ink' : 'border-transparent'
                }`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Optional — shown on the department&rsquo;s tile in lists and pickers.
          </p>
          <input type="hidden" name="color" value={color} />
        </div>

        <Field
          label="Sort order"
          hint="Lower numbers list first."
          className="max-w-40"
        >
          <NumberInput name="sortOrder" precision={0} defaultValue={department?.sortOrder ?? 0} />
        </Field>

        {/* The save action reads the old checkbox contract: 'on' means active,
            anything else means inactive — so the switch submits exactly that. */}
        <input type="hidden" name="isActive" value={active ? 'on' : ''} />
        <Switch
          checked={active}
          onChange={setActive}
          label="Active"
          hint="Switch off to hide it from pickers without touching its products."
        />
      </FieldGroup>

      <div className="flex items-center border-t border-border pt-4">
        <SubmitButton />
      </div>
    </form>
  )
}

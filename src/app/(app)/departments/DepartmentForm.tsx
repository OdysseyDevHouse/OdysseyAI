'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { StatusError as AlertCircle, Save } from '@/components/ui/icons'
import { Button, TILE_SWATCHES } from '@/components/ui'
import { saveDepartmentAction, type DepartmentFormState } from './actions'
import type { Department } from '@/lib/site/departments'

const field = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink'
const labelText = 'text-xs font-medium text-muted'

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

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      {department && <input type="hidden" name="id" value={department.id} />}

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertCircle size={15} />
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Name *</span>
          <input
            name="name"
            defaultValue={department?.name ?? ''}
            required
            maxLength={120}
            autoFocus
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Code</span>
          <input
            name="code"
            defaultValue={department?.code ?? ''}
            maxLength={32}
            placeholder="Optional"
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Sits under</span>
          <select
            name="parentId"
            defaultValue={department ? (department.parentId ?? '') : (defaultParentId ?? '')}
            className={field}
          >
            <option value="">&lt;Top level&gt;</option>
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Sort order</span>
          <input
            name="sortOrder"
            type="number"
            step="1"
            defaultValue={department?.sortOrder ?? 0}
            className={`${field} numeric`}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelText}>Colour</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setColor('')}
            aria-pressed={color === ''}
            className={color === '' ? 'border-ink text-ink' : ''}
          >
            None
          </Button>
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
        <input type="hidden" name="color" value={color} />
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={department?.isActive ?? true}
          className="size-4"
        />
        Active
      </label>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <SubmitButton />
        <Link href="/departments" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  )
}

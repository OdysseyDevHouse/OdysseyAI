'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Save } from 'lucide-react'
import { saveDepartmentAction, type DepartmentFormState } from './actions'
import type { Department } from '@/lib/site/departments'

const field = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink'
const labelText = 'text-xs font-medium text-muted'

const PALETTE = ['#2f6fed', '#0f7b4f', '#b5730a', '#c02626', '#6b21a8', '#0e7490', '#475569']

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-ink disabled:opacity-60"
    >
      <Save size={15} />
      {pending ? 'Saving…' : 'Save department'}
    </button>
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
          <button
            type="button"
            onClick={() => setColor('')}
            className={`rounded border px-2 py-1 text-xs transition ${
              color === '' ? 'border-ink text-ink' : 'border-border text-muted hover:text-ink'
            }`}
          >
            None
          </button>
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              className={`size-6 rounded-full border-2 transition ${
                color === c ? 'border-ink' : 'border-transparent'
              }`}
              style={{ background: c }}
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

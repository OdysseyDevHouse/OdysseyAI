'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Save } from 'lucide-react'
import { saveSupplierAction, type SupplierFormState } from './actions'
import type { Supplier } from '@/lib/suppliers'

const field = 'rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink w-full'
const labelText = 'text-xs font-medium text-muted'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-ink disabled:opacity-60"
    >
      <Save size={15} />
      {pending ? 'Saving…' : 'Save supplier'}
    </button>
  )
}

export default function SupplierForm({ supplier }: { supplier: Supplier | null }) {
  const [state, formAction] = useActionState<SupplierFormState, FormData>(saveSupplierAction, {
    error: null,
  })

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      {supplier && <input type="hidden" name="id" value={supplier.id} />}

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertCircle size={15} />
          {state.error}
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Supplier code *</span>
          <input name="code" defaultValue={supplier?.code ?? ''} required className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Name *</span>
          <input name="name" defaultValue={supplier?.name ?? ''} required className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Contact person</span>
          <input name="contactName" defaultValue={supplier?.contactName ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Email</span>
          <input name="email" type="email" defaultValue={supplier?.email ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Phone</span>
          <input name="phone" defaultValue={supplier?.phone ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>VAT number</span>
          <input name="vatNumber" defaultValue={supplier?.vatNumber ?? ''} className={field} />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Address line 1</span>
          <input name="addressLine1" defaultValue={supplier?.addressLine1 ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Address line 2</span>
          <input name="addressLine2" defaultValue={supplier?.addressLine2 ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>City</span>
          <input name="city" defaultValue={supplier?.city ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Postal code</span>
          <input name="postalCode" defaultValue={supplier?.postalCode ?? ''} className={field} />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Our account number</span>
          <input
            name="accountNumber"
            defaultValue={supplier?.accountNumber ?? ''}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Payment terms (days)</span>
          <input
            name="paymentTermsDays"
            type="number"
            min="0"
            max="365"
            defaultValue={supplier?.paymentTermsDays ?? 30}
            className={`${field} numeric`}
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={labelText}>Notes</span>
          <textarea name="notes" defaultValue={supplier?.notes ?? ''} rows={2} className={field} />
        </label>
      </section>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={supplier?.isActive ?? true}
          className="size-4"
        />
        Active
      </label>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <SubmitButton />
        <Link href="/suppliers" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  )
}

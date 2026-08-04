'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Save } from 'lucide-react'
import { saveCustomerAction, type CustomerFormState } from './actions'
import type { Customer } from '@/lib/customers'

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
      {pending ? 'Saving…' : 'Save customer'}
    </button>
  )
}

export default function CustomerForm({ customer }: { customer: Customer | null }) {
  const [state, formAction] = useActionState<CustomerFormState, FormData>(saveCustomerAction, {
    error: null,
  })

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      {customer && <input type="hidden" name="id" value={customer.id} />}

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
          <span className={labelText}>Customer code *</span>
          <input name="code" defaultValue={customer?.code ?? ''} required className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Name *</span>
          <input name="name" defaultValue={customer?.name ?? ''} required className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Contact person</span>
          <input name="contactName" defaultValue={customer?.contactName ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Email</span>
          <input
            name="email"
            type="email"
            defaultValue={customer?.email ?? ''}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Phone</span>
          <input name="phone" defaultValue={customer?.phone ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>VAT number</span>
          <input name="vatNumber" defaultValue={customer?.vatNumber ?? ''} className={field} />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Address line 1</span>
          <input name="addressLine1" defaultValue={customer?.addressLine1 ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Address line 2</span>
          <input name="addressLine2" defaultValue={customer?.addressLine2 ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>City</span>
          <input name="city" defaultValue={customer?.city ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Postal code</span>
          <input name="postalCode" defaultValue={customer?.postalCode ?? ''} className={field} />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Credit limit</span>
          <input
            name="creditLimit"
            type="number"
            step="0.01"
            min="0"
            defaultValue={customer?.creditLimit ?? 0}
            className={`${field} numeric`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Loyalty number</span>
          <input
            name="loyaltyNumber"
            defaultValue={customer?.loyaltyNumber ?? ''}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={labelText}>Notes</span>
          <textarea name="notes" defaultValue={customer?.notes ?? ''} rows={2} className={field} />
        </label>
      </section>

      <section className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="onHold"
            defaultChecked={customer?.onHold ?? false}
            className="size-4"
          />
          On hold (refuse credit)
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={customer?.isActive ?? true}
            className="size-4"
          />
          Active
        </label>
      </section>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <SubmitButton />
        <Link href="/customers" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  )
}

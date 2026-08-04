'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Save } from 'lucide-react'
import { saveProductAction, type ProductFormState } from './actions'
import type { Product } from '@/lib/products'
import type { Department, VatRate } from '@/lib/lookups'
import type { Supplier } from '@/lib/suppliers'
import { markupPercent, marginPercent } from '@/lib/decimals'

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
      {pending ? 'Saving…' : 'Save product'}
    </button>
  )
}

export default function ProductForm({
  product,
  departments,
  suppliers,
  vatRates,
}: {
  product: Product | null
  departments: Department[]
  suppliers: Supplier[]
  vatRates: VatRate[]
}) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(saveProductAction, {
    error: null,
  })

  // Live margin readout as the user types — the number that decides whether a
  // price is worth setting, so it shouldn't require a save to see.
  const defaultVat =
    vatRates.find((v) => v.id === product?.vatRateId) ?? vatRates.find((v) => v.isDefault)
  const [cost, setCost] = useState(product?.costPrice ?? 0)
  const [sell, setSell] = useState(product?.sellingPrice ?? 0)
  const [vat, setVat] = useState(defaultVat?.rate ?? 0)

  const margin = marginPercent(cost, sell, vat)
  const markup = markupPercent(cost, sell, vat)

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      {product && <input type="hidden" name="id" value={product.id} />}

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
          <span className={labelText}>Product code *</span>
          <input name="sku" defaultValue={product?.sku ?? ''} required className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Barcode</span>
          <input
            name="barcode"
            defaultValue={product?.primaryBarcode ?? ''}
            className={field}
            placeholder="Scan or type"
          />
        </label>

        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={labelText}>Name *</span>
          <input name="name" defaultValue={product?.name ?? ''} required className={field} />
        </label>

        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={labelText}>Description</span>
          <textarea
            name="description"
            defaultValue={product?.description ?? ''}
            rows={2}
            className={field}
          />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Department</span>
          <select name="departmentId" defaultValue={product?.departmentId ?? ''} className={field}>
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Supplier</span>
          <select name="supplierId" defaultValue={product?.supplierId ?? ''} className={field}>
            <option value="">— None —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Unit</span>
          <input name="unit" defaultValue={product?.unit ?? 'each'} className={field} />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Cost price (excl. VAT)</span>
          <input
            name="costPrice"
            type="number"
            step="0.0001"
            min="0"
            defaultValue={product?.costPrice ?? 0}
            onChange={(e) => setCost(Number(e.target.value) || 0)}
            className={`${field} numeric`}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Selling price (incl. VAT)</span>
          <input
            name="sellingPrice"
            type="number"
            step="0.0001"
            min="0"
            defaultValue={product?.sellingPrice ?? 0}
            onChange={(e) => setSell(Number(e.target.value) || 0)}
            className={`${field} numeric`}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>VAT rate</span>
          <select
            name="vatRateId"
            defaultValue={product?.vatRateId ?? defaultVat?.id ?? ''}
            onChange={(e) => {
              const found = vatRates.find((v) => v.id === Number(e.target.value))
              setVat(found?.rate ?? 0)
            }}
            className={field}
          >
            <option value="">— None —</option>
            {vatRates.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.rate}%)
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="flex gap-6 rounded-md bg-surface-2 px-4 py-3 text-sm">
        <div>
          <div className={labelText}>Margin</div>
          <div className={`numeric font-semibold ${margin < 0 ? 'text-danger' : 'text-ink'}`}>
            {margin.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className={labelText}>Markup</div>
          <div className={`numeric font-semibold ${markup < 0 ? 'text-danger' : 'text-ink'}`}>
            {markup.toFixed(2)}%
          </div>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Reorder level</span>
          <input
            name="reorderLevel"
            type="number"
            step="0.001"
            min="0"
            defaultValue={product?.reorderLevel ?? 0}
            className={`${field} numeric`}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={labelText}>Reorder quantity</span>
          <input
            name="reorderQty"
            type="number"
            step="0.001"
            min="0"
            defaultValue={product?.reorderQty ?? 0}
            className={`${field} numeric`}
          />
        </label>

        {!product && (
          <label className="flex flex-col gap-1.5">
            <span className={labelText}>Opening stock</span>
            <input
              name="stockOnHand"
              type="number"
              step="0.001"
              defaultValue={0}
              className={`${field} numeric`}
            />
          </label>
        )}
      </section>

      <section className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="trackStock"
            defaultChecked={product?.trackStock ?? true}
            className="size-4"
          />
          Track stock
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={product?.isActive ?? true}
            className="size-4"
          />
          Active
        </label>
      </section>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <SubmitButton />
        <Link href="/products" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  )
}

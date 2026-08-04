'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Save } from 'lucide-react'
import RichText from '@/components/RichText'
import DepartmentPicker from '@/components/DepartmentPicker'
import PricingPanel from '@/components/PricingPanel'
import { Card } from '@/components/ui'
import { saveProductAction, type ProductFormState } from './actions'
import type { Product } from '@/lib/site/products'
import type { Brand, VatRate, PriceStructure } from '@/lib/site/lookups'
import type { Department } from '@/lib/site/departments'
import type { CostBasis } from '@/lib/pricing'

const field = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink'
const labelText = 'text-xs font-medium text-muted'

const TILE_COLORS = ['#2f6fed', '#0f7b4f', '#b5730a', '#c02626', '#6b21a8', '#0e7490', '#475569']

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-border px-6 py-3.5 text-sm font-semibold text-ink">
      {children}
    </h2>
  )
}

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

function formatDate(value: Date | string | null): string {
  if (!value) return ''
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function ProductForm({
  product,
  departments,
  brands,
  vatRates,
  structures,
  costBasis,
}: {
  product: Product | null
  departments: Department[]
  brands: Brand[]
  vatRates: VatRate[]
  structures: PriceStructure[]
  costBasis: CostBasis
}) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(saveProductAction, {
    error: null,
  })

  const isNew = product === null
  const [description, setDescription] = useState(product?.description ?? '')
  const [color, setColor] = useState(product?.imageColor ?? TILE_COLORS[0])

  const defaultPrices: Record<number, number> = {}
  for (const s of structures) {
    defaultPrices[s.id] = product?.prices.find((p) => p.priceStructureId === s.id)?.sellIncl ?? 0
  }

  const initial = (description.trim()[0] ?? '?').toUpperCase()

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {product && <input type="hidden" name="id" value={product.id} />}

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Link href="/products" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertCircle size={15} />
          {state.error}
        </p>
      )}

      {/* ── Product overview ─────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Product overview</SectionTitle>
        <div className="flex flex-col gap-5 p-6">
          <label className="flex flex-col gap-1.5">
            <span className={labelText}>Description *</span>
            <input
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              maxLength={190}
              className={field}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={labelText}>Product code *</span>
              <input
                name="code"
                defaultValue={product?.code ?? ''}
                required
                maxLength={48}
                // Editable on create, fixed afterwards: the code is how stock
                // movements and orders refer to this product.
                readOnly={!isNew}
                className={`${field} ${!isNew ? 'bg-surface-2 text-muted' : ''}`}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={labelText}>Barcode</span>
              <input
                name="barcode"
                defaultValue={product?.barcode ?? ''}
                maxLength={64}
                placeholder="Scan or type"
                className={field}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-start gap-6">
            <div className="flex flex-col gap-1.5">
              <span className={labelText}>Product image</span>
              <div className="flex items-start gap-3">
                <div
                  className="flex size-20 shrink-0 flex-col items-center justify-center rounded-md text-white"
                  style={{ background: color }}
                >
                  <span className="text-2xl font-semibold">{initial}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {TILE_COLORS.map((c) => (
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
                  <p className="max-w-64 text-xs text-muted">
                    Upload, icon search and generated images aren&apos;t built yet — they need a
                    storage decision first.
                  </p>
                </div>
              </div>
              <input type="hidden" name="imageColor" value={color} />
            </div>

            <label className="flex items-start gap-2.5 pt-6 text-sm text-ink">
              <input
                type="checkbox"
                name="isArchived"
                defaultChecked={product?.isArchived ?? false}
                className="mt-0.5 size-4"
              />
              <span>
                Archive product
                <span className="mt-0.5 block max-w-72 text-xs font-normal text-muted">
                  Archived products are hidden from normal operations but remain available for
                  reporting and historical transactions.
                </span>
              </span>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={labelText}>Extra description</span>
            <RichText
              name="extraDescription"
              defaultValue={product?.extraDescription ?? ''}
              placeholder="Longer description, ingredients, specifications…"
            />
          </label>

          {product && (
            <div className="grid gap-4 sm:grid-cols-4">
              {(
                [
                  ['Last edit date', product.lastEditDate],
                  ['Last purchase', product.lastPurchaseDate],
                  ['Last sold', product.lastSoldDate],
                  ['Last adjusted', product.lastAdjustDate],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <span className={labelText}>{label}</span>
                  <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
                    {formatDate(value) || 'No date available'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* ── Departments ──────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Departments</SectionTitle>
        <div className="flex flex-col gap-4 p-6">
          {departments.length === 0 ? (
            <p className="text-sm text-muted">
              No departments exist yet. Products can still be saved without one.
            </p>
          ) : (
            <DepartmentPicker
              name="departmentId"
              departments={departments}
              defaultValue={product?.departmentId ?? null}
            />
          )}

          <label className="flex max-w-xs flex-col gap-1.5">
            <span className={labelText}>Brand</span>
            <select name="brandId" defaultValue={product?.brandId ?? ''} className={field}>
              <option value="">&lt;None&gt;</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {/* ── Pricing ──────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Cost and selling prices</SectionTitle>
        <PricingPanel
          vatRates={vatRates}
          structures={structures}
          costBasis={costBasis}
          defaultCostExcl={product?.lastCost ?? 0}
          defaultAverageCost={product?.averageCost ?? 0}
          defaultPurchaseVatId={product?.purchaseVatRateId ?? null}
          defaultSellingVatId={product?.sellingVatRateId ?? null}
          defaultPrices={defaultPrices}
          isNew={isNew}
        />
      </Card>

      {/* ── Inventory ────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Inventory</SectionTitle>
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={labelText}>Minimum level</span>
            <input
              name="minStock"
              type="number"
              step="0.001"
              min="0"
              defaultValue={product?.minStock ?? 0}
              className={`${field} numeric`}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={labelText}>Maximum level</span>
            <input
              name="maxStock"
              type="number"
              step="0.001"
              min="0"
              defaultValue={product?.maxStock ?? 0}
              className={`${field} numeric`}
            />
          </label>

          {isNew ? (
            <label className="flex flex-col gap-1.5">
              <span className={labelText}>Opening stock</span>
              <input
                name="openingStock"
                type="number"
                step="0.001"
                defaultValue={0}
                className={`${field} numeric`}
              />
            </label>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className={labelText}>
                Stock on hand
                <span className="ml-1 font-normal opacity-70">(from movements)</span>
              </span>
              <div className="numeric rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
                {product.stockOnHand}
              </div>
            </div>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-3 pb-2">
        <SubmitButton />
        <Link href="/products" className="text-sm text-muted hover:text-ink">
          Cancel
        </Link>
      </div>
    </form>
  )
}

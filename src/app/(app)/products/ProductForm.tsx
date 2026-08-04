'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { StatusError, Save } from '@/components/ui/icons'
import RichText from '@/components/RichText'
import DepartmentPicker from '@/components/DepartmentPicker'
import PricingPanel, { type StoreLine } from '@/components/PricingPanel'
import InventoryPanel from '@/components/InventoryPanel'
import LinkedStoresPanel from '@/components/LinkedStoresPanel'
import type { LinkedProductView } from '@/lib/site/productFanout'
import ProductTypePanel from '@/components/ProductTypePanel'
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Select,
  Tabs,
  TILE_SWATCHES,
  tileClass,
} from '@/components/ui'
import { Info, LayoutGrid, Warehouse, Shapes, Store } from '@/components/ui/icons'
import { DEFAULT_PRODUCT_TYPE } from '@/lib/productTypes'
import { saveProductAction, type ProductFormState } from './actions'
import type { Product } from '@/lib/site/products'
import type { Brand, VatRate, PriceStructure } from '@/lib/site/lookups'
import type { Department } from '@/lib/site/departments'
import type { CostBasis } from '@/lib/pricing'

/* The image swatch block isn't a form control, so it labels itself rather than
   using <Field>, which wires a label to an input. */
const labelText = 'mb-1.5 block text-sm font-medium text-ink-2'


type TabValue = 'general' | 'linked'

/* Lets the Save button live outside the <form> it submits. */
const FORM_ID = 'product-form'

function SubmitButton({ formId }: { formId: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" form={formId} variant="primary" disabled={pending}>
      <Save size={15} />
      {pending ? 'Saving…' : 'Save product'}
    </Button>
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
  storeName,
  currentSiteId,
  linkedStores,
  linkedLines,
  sharesCost: defaultSharesCost,
  sharesSelling: defaultSharesSelling,
  rowActions,
}: {
  product: Product | null
  departments: Department[]
  brands: Brand[]
  vatRates: VatRate[]
  structures: PriceStructure[]
  costBasis: CostBasis
  storeName: string
  currentSiteId: number
  /** The same product in the other stores linked to this one. Empty if unlinked. */
  linkedStores: LinkedProductView[]
  /** Editable lines for those stores, keyed to this store's price structures. */
  linkedLines: StoreLine[]
  sharesCost: boolean
  sharesSelling: boolean
  /**
   * Buttons shown beside Save. They carry their own <form action>, so they are
   * passed in rather than rendered here — a nested form is invalid HTML and the
   * browser would silently drop the inner one.
   */
  rowActions?: React.ReactNode
}) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(saveProductAction, {
    error: null,
  })

  const isNew = product === null
  const [description, setDescription] = useState(product?.description ?? '')
  // Existing rows may still hold a hex from before these became tokens;
  // tileClass() falls back to the first swatch rather than rendering nothing.
  const [color, setColor] = useState(product?.imageColor ?? TILE_SWATCHES[0].token)

  // The sharing toggles live here rather than in either panel: the pricing
  // tables need them to decide which rows are editable, and the linked-stores
  // card owns the controls. One source of truth, read by both.
  const [sharesCost, setSharesCost] = useState(defaultSharesCost)
  const [sharesSelling, setSharesSelling] = useState(defaultSharesSelling)

  // The tab bar only appears once this store is linked to another — a
  // standalone store has a single tab's worth of content and no second view.
  const isLinked = linkedStores.length > 1
  const [tab, setTab] = useState<TabValue>('general')

  const defaultPrices: Record<number, number> = {}
  for (const s of structures) {
    defaultPrices[s.id] = product?.prices.find((p) => p.priceStructureId === s.id)?.sellIncl ?? 0
  }

  const initial = (description.trim()[0] ?? '?').toUpperCase()

  // Capped rather than full-bleed: the pricing tables are wide, but past about
  // 1100px the form's labelled fields stretch into unreadable lines.
  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-4">
      {/* The action row sits OUTSIDE the form. Archive and delete carry their
          own <form action>, and a nested form is invalid HTML — the browser
          drops the inner one silently. Save reaches its form by id instead. */}
      <div className="flex items-center gap-2">
        <SubmitButton formId={FORM_ID} />
        {rowActions}
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-4">
        {product && <input type="hidden" name="id" value={product.id} />}

        {state.error && (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <StatusError size={15} />
            {state.error}
          </p>
        )}

        {isLinked && (
          <Tabs
            aria-label="Product sections"
            items={[
              { value: 'general', label: 'General', icon: <Info size={16} /> },
              {
                value: 'linked',
                label: 'Linked stores',
                icon: <Store size={16} />,
                count: linkedStores.length - 1,
              },
            ]}
            value={tab}
            onChange={setTab}
          />
        )}

        {/* Hidden rather than unmounted for the same reason as the linked tab:
            every field below is part of this one form and must still submit. */}
        <div className={tab === 'general' ? 'flex flex-col gap-4' : 'hidden'}>
          {/* ── Product overview ─────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon={<Info size={16} />}>Product overview</SectionTitle>
            <div className="flex flex-col gap-5 p-6">
              <Field label="Description *">
                <Input
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  maxLength={190}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Product code *"
                  hint={isNew ? undefined : 'Fixed after creation — stock movements refer to it'}
                >
                  <Input
                    name="code"
                    defaultValue={product?.code ?? ''}
                    required
                    maxLength={48}
                    // Editable on create, fixed afterwards: the code is how stock
                    // movements and orders refer to this product.
                    readOnly={!isNew}
                    disabled={!isNew}
                  />
                </Field>

                <Field label="Barcode">
                  <Input
                    name="barcode"
                    defaultValue={product?.barcode ?? ''}
                    maxLength={64}
                    placeholder="Scan or type"
                  />
                </Field>
              </div>

              <div className="flex flex-wrap items-start gap-6">
                <div className="flex flex-col gap-1.5">
                  <span className={labelText}>Product image</span>
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex size-20 shrink-0 flex-col items-center justify-center rounded-card text-white ${tileClass(color)}`}
                    >
                      <span className="text-2xl font-semibold">{initial}</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-1.5">
                        {TILE_SWATCHES.map((c) => (
                          <button
                            key={c.token}
                            data-kit-ok
                            type="button"
                            aria-label={`Colour ${c.token}`}
                            aria-pressed={color === c.token}
                            onClick={() => setColor(c.token)}
                            className={`size-6 rounded-pill border-2 transition ${c.className} ${
                              color === c.token ? 'border-ink' : 'border-transparent'
                            }`}
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

                <div className="flex flex-col gap-1 pt-6">
                  <Checkbox
                    name="isArchived"
                    label="Archive product"
                    defaultChecked={product?.isArchived ?? false}
                  />
                  <p className="ml-6 max-w-72 text-xs text-muted">
                    Archived products are hidden from normal operations but remain available for
                    reporting and historical transactions.
                  </p>
                </div>
              </div>

              <Field label="Extra description">
                <RichText
                  name="extraDescription"
                  defaultValue={product?.extraDescription ?? ''}
                  placeholder="Longer description, ingredients, specifications…"
                />
              </Field>

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
                    <Field key={label} label={label}>
                      <div className="rounded-control border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
                        {formatDate(value) || 'No date available'}
                      </div>
                    </Field>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* ── Departments ──────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon={<LayoutGrid size={16} />}>Departments</SectionTitle>
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

              <Field label="Brand" className="max-w-xs">
                <Select name="brandId" defaultValue={product?.brandId ?? ''}>
                  <option value="">&lt;None&gt;</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>

          {/* ── Pricing ──────────────────────────────────────────────────── */}
          {/* Renders its own two cards — cost and selling are separate blocks. */}
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
            storeName={storeName}
            linkedLines={linkedLines}
            sharesCost={sharesCost}
            sharesSelling={sharesSelling}
          />

          {/* ── Inventory ────────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon={<Warehouse size={16} />}>Inventory</SectionTitle>
            <InventoryPanel
              isNew={isNew}
              rows={[
                {
                  // 0 marks the store being edited, whose fields keep their plain
                  // names so the ordinary single-store save path is unchanged.
                  storeId: 0,
                  storeName,
                  stockOnHand: product?.stockOnHand ?? 0,
                  minStock: product?.minStock ?? 0,
                  maxStock: product?.maxStock ?? 0,
                },
                ...linkedStores
                  .filter((view) => view.store.siteId !== currentSiteId)
                  .map((view) => ({
                    storeId: view.store.siteId,
                    storeName: view.store.displayName,
                    stockOnHand: view.stockOnHand,
                    minStock: view.minStock,
                    maxStock: view.maxStock,
                  })),
              ]}
            />
          </Card>

          {/* ── Product type ─────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon={<Shapes size={16} />}>Product type</SectionTitle>
            <ProductTypePanel defaultValue={product?.productType ?? DEFAULT_PRODUCT_TYPE} />
          </Card>
        </div>

        {/* ── Linked stores ────────────────────────────────────────────── */}
        {/* Hidden with CSS rather than unmounted: this panel holds the sharing
            toggles, and a tab switch must not drop them from the submitted form. */}
        {isLinked && (
          <div className={tab === 'linked' ? 'flex flex-col gap-4' : 'hidden'}>
            <Card>
              <SectionTitle icon={<Store size={16} />}>Linked stores</SectionTitle>
              <LinkedStoresPanel
                stores={linkedStores}
                currentSiteId={currentSiteId}
                sharesCost={sharesCost}
                sharesSelling={sharesSelling}
                onSharesCostChange={setSharesCost}
                onSharesSellingChange={setSharesSelling}
              />
            </Card>
          </div>
        )}

      </form>
    </div>
  )
}

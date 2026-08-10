'use client'

import { useActionState, useState } from 'react'
import { Save } from '@/components/ui/icons'
import RichText from '@/components/RichText'
import DepartmentPicker from '@/components/DepartmentPicker'
import PricingPanel, { type StoreLine } from '@/components/PricingPanel'
import LocationStockPanel, { type LocationStockRow } from '@/components/LocationStockPanel'
import LinkedStoresPanel from '@/components/LinkedStoresPanel'
import type { LinkedProductView } from '@/lib/site/productFanout'
import ProductTypePanel from '@/components/ProductTypePanel'
import TillTilePanel from './TillTilePanel'
import PropertiesPanel from '@/components/PropertiesPanel'
import InstructionsPanel from '@/components/InstructionsPanel'
import RecipePanel from '@/components/RecipePanel'
import ReferPanel from '@/components/ReferPanel'
import SerialsPanel from '@/components/SerialsPanel'
import ProductSuppliersPanel from '@/components/ProductSuppliersPanel'
import type { InstructionGroup } from '@/lib/site/instructions'
import type { RecipeLine, ReferLink } from '@/lib/site/productComposition'
import type { Serial } from '@/lib/site/serials'
import type { ProductSupplier } from '@/lib/site/productSuppliers'
import {
  Button,
  Callout,
  Card,
  EDIT_COLUMN,
  Field,
  Input,
  SectionTitle,
  Select,
  Tabs,
  TILE_SWATCHES,
} from '@/components/ui'
import {
  Info,
  LayoutGrid,
  Warehouse,
  Shapes,
  Store,
  Tag,
  Lightbulb,
  Truck,
  Barcode,
  ArrowLeftRight,
} from '@/components/ui/icons'
import { DEFAULT_PRODUCT_TYPE, type ProductTypeId } from '@/lib/productTypes'
import { saveProductAction, type ProductFormState } from './actions'
import type { Product } from '@/lib/site/products'
import type { Brand, VatRate, PriceStructure } from '@/lib/site/lookups'
import type { Department } from '@/lib/site/departments'
import type { CostBasis } from '@/lib/pricing'

type TabValue =
  | 'general'
  | 'properties'
  | 'instructions'
  | 'suppliers'
  | 'recipe'
  | 'refer'
  | 'serials'
  | 'linked'

/** Which tab configures a given product type, for the setup buttons. */
const SETUP_TAB: Partial<Record<ProductTypeId, TabValue>> = {
  recipe: 'recipe',
  refer: 'refer',
  serial: 'serials',
}

/* Lets the Save button live outside the <form> it submits — it now sits in the
   page header, which is rendered by the page rather than nested in this tree. */
const FORM_ID = 'product-form'

/**
 * The header's Save, submitting the form below by id.
 *
 * Rendered by the page into <PageHeader action>, so it is a sibling of the form
 * rather than a descendant. That rules out useFormStatus, which reads the
 * nearest ancestor <form> and would report pending:false here forever; the
 * button is deliberately stateless and the disabled-while-saving affordance
 * lives with the form's own useActionState.
 */
export function SaveProductButton() {
  return (
    <Button type="submit" form={FORM_ID} variant="primary">
      <Save size={15} />
      Save product
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
  locationStock = [],
  linkedLines,
  sharesCost: defaultSharesCost,
  sharesSelling: defaultSharesSelling,
  instructionGroups,
  attachedInstructions,
  recipeLines,
  referLink,
  serials,
  productSuppliers,
  suggestedCode = null,
}: {
  product: Product | null
  /**
   * Pre-filled code for a new product, or null when auto-numbering is off.
   * A suggestion only — see lib/site/masterCodes.ts.
   */
  suggestedCode?: string | null
  departments: Department[]
  brands: Brand[]
  vatRates: VatRate[]
  structures: PriceStructure[]
  costBasis: CostBasis
  storeName: string
  currentSiteId: number
  /** The same product in the other stores linked to this one. Empty if unlinked. */
  linkedStores: LinkedProductView[]
  /**
   * This product's stock broken down by location WITHIN this site — a
   * different axis from linkedStores, which is other sites. Defaults to empty
   * so the new-product form, which has no piles yet, need not pass it.
   */
  locationStock?: LocationStockRow[]
  /** Editable lines for those stores, keyed to this store's price structures. */
  linkedLines: StoreLine[]
  sharesCost: boolean
  sharesSelling: boolean
  /** Every active instruction in the library, for the Instructions tab. */
  instructionGroups: InstructionGroup[]
  /** Ids of the instructions this product currently asks. */
  attachedInstructions: number[]
  /** The ingredient list, for a recipe product. Empty otherwise. */
  recipeLines: RecipeLine[]
  /** What a refer product draws its stock from, or null. */
  referLink: ReferLink | null
  /** The individual units of a serial product. Empty otherwise. */
  serials: Serial[]
  /** Who this product is bought from. */
  productSuppliers: ProductSupplier[]
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

  // Which stores carry this product. Seeded from what each store recorded, so
  // an untouched save writes back exactly what was already true.
  const [availability, setAvailability] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(linkedStores.map((view) => [view.store.siteId, view.available])),
  )
  const setStoreAvailable = (siteId: number, value: boolean) =>
    setAvailability((prev) => ({ ...prev, [siteId]: value }))

  // The tab bar only appears once this store is linked to another — a
  // standalone store has a single tab's worth of content and no second view.
  const isLinked = linkedStores.length > 1
  const [tab, setTab] = useState<TabValue>('general')

  // Tracked live so the Recipe, Refer and Serials tabs appear with the type
  // they belong to, rather than only after a save-and-reload.
  const [productType, setProductType] = useState<ProductTypeId>(
    product?.productType ?? DEFAULT_PRODUCT_TYPE,
  )

  const defaultPrices: Record<number, number> = {}
  for (const s of structures) {
    defaultPrices[s.id] = product?.prices.find((p) => p.priceStructureId === s.id)?.sellIncl ?? 0
  }

  const initial = (description.trim()[0] ?? '?').toUpperCase()

  // EDIT_COLUMN, not a literal: the variants and photographs panels below this
  // form are separate siblings on the page and have to match it exactly.
  return (
    <div className={`flex ${EDIT_COLUMN} flex-col gap-4`}>
      <form id={FORM_ID} action={formAction} className="flex flex-col gap-4">
        {product && <input type="hidden" name="id" value={product.id} />}

        {/* Archiving moved to the header's Actions menu, but the save path still
            reads this field — without it every save would send nothing and
            quietly un-archive the product. Carries the current state through
            untouched; only the menu changes it. */}
        {product?.isArchived && <input type="hidden" name="isArchived" value="on" />}

        {state.error && (
          <Callout tone="danger" title="Could not save">
            {state.error}
          </Callout>
        )}

        {/* Always rendered now: Properties exists whether or not this store is
            linked to another, so there is always a second tab's worth of
            content. Linked stores only joins the bar once there is one. */}
        <Tabs
          aria-label="Product sections"
          items={[
            { value: 'general', label: 'General', icon: <Info size={16} /> },
            { value: 'properties', label: 'Properties', icon: <Tag size={16} /> },
            {
              value: 'instructions',
              label: 'Instructions',
              icon: <Lightbulb size={16} />,
              count: attachedInstructions.length || undefined,
            },
            {
              value: 'suppliers',
              label: 'Suppliers',
              icon: <Truck size={16} />,
              count: productSuppliers.length || undefined,
            },
            // The composition tabs follow the product's type: an ingredient
            // list on a normal product is a question nobody asked.
            ...(productType === 'recipe'
              ? [
                  {
                    value: 'recipe',
                    label: 'Recipe',
                    icon: <Shapes size={16} />,
                    count: recipeLines.length || undefined,
                  },
                ]
              : []),
            ...(productType === 'refer'
              ? [{ value: 'refer', label: 'Refer', icon: <ArrowLeftRight size={16} /> }]
              : []),
            ...(productType === 'serial'
              ? [
                  {
                    value: 'serials',
                    label: 'Serials',
                    icon: <Barcode size={16} />,
                    count: serials.length || undefined,
                  },
                ]
              : []),
            ...(isLinked
              ? [
                  {
                    value: 'linked',
                    label: 'Linked stores',
                    icon: <Store size={16} />,
                    count: linkedStores.length - 1,
                  },
                ]
              : []),
          ]}
          value={tab}
          onChange={(next) => setTab(next as TabValue)}
        />

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
                  label={isNew && suggestedCode ? 'Product code' : 'Product code *'}
                  hint={
                    !isNew
                      ? 'Fixed after creation — stock movements refer to it'
                      : suggestedCode
                        ? 'Filled in for you. Type over it to use your own.'
                        : undefined
                  }
                >
                  {/* Clearing the field is how a user asks for the next code —
                      see the note in CustomerForm. */}
                  <Input
                    name="code"
                    defaultValue={product?.code ?? suggestedCode ?? ''}
                    required={!(isNew && suggestedCode)}
                    maxLength={48}
                    // Editable on create, fixed afterwards: the code is how stock
                    // movements and orders refer to this product.
                    //
                    // readOnly, NOT disabled. A disabled input is not submitted
                    // at all, so every edit-product save arrived with no code
                    // and was refused with "A product code is required" — the
                    // whole screen could not be saved. readOnly refuses the
                    // edit but still posts the value.
                    readOnly={!isNew}
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

              <TillTilePanel
                productId={product?.id ?? null}
                initial={initial}
                color={color}
                onColorChange={setColor}
                initialIcon={product?.imageIcon ?? null}
              />

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

          {/* ── Inventory ────────────────────────────────────────────────────
              One card, every store, every room. This replaced a per-STORE
              Inventory table: that could only show a store total, and a total
              is exactly the figure that hides 57 units sitting in a back
              warehouse. Stock lives in rooms; a store is the outer grouping. */}
          <Card>
            <SectionTitle icon={<Warehouse size={16} />}>Inventory</SectionTitle>
            <LocationStockPanel
              isNew={isNew}
              stores={[
                {
                  siteId: currentSiteId,
                  storeName,
                  isCurrent: true,
                  carried: true,
                  rows: locationStock,
                },
                ...linkedStores
                  .filter((view) => view.store.siteId !== currentSiteId)
                  .map((view) => ({
                    siteId: view.store.siteId,
                    storeName: view.store.displayName,
                    siteCode: view.store.siteCode,
                    isCurrent: false,
                    carried: view.found && !view.archived,
                    rows: view.locations.map((l) => ({
                      locationId: l.locationId,
                      code: l.code,
                      name: l.name,
                      isMain: l.isMain,
                      // Another store's rooms are only read here, and the query
                      // already excludes inactive ones holding nothing.
                      isActive: true,
                      stockOnHand: l.stockOnHand,
                      minStock: l.minStock,
                      maxStock: l.maxStock,
                    })),
                  })),
              ]}
            />
          </Card>

          {/* ── Product type ─────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon={<Shapes size={16} />}>Product type</SectionTitle>
            <ProductTypePanel
              defaultValue={product?.productType ?? DEFAULT_PRODUCT_TYPE}
              onChange={setProductType}
              onSetupClick={(type) => {
                const target = SETUP_TAB[type]
                if (target) setTab(target)
              }}
            />
          </Card>
        </div>

        {/* ── Linked stores ────────────────────────────────────────────── */}
        {/* ── Properties ───────────────────────────────────────────────── */}
        {/* Hidden with CSS, never unmounted — the switches submit through hidden
            inputs, and dropping them would save every property as off. */}
        <div className={tab === 'properties' ? 'flex flex-col gap-4' : 'hidden'}>
          <PropertiesPanel
            value={{
              // A new product starts visible in the POS and otherwise plain,
              // matching the column defaults in migration 006.
              visibleInPos: product?.visibleInPos ?? true,
              changeDescription: product?.changeDescription ?? false,
              askPriceAtSale: product?.askPriceAtSale ?? false,
              allowFractions: product?.allowFractions ?? false,
              chargePctSubtotal: product?.chargePctSubtotal ?? false,
              nonGpProduct: product?.nonGpProduct ?? false,
              maxDiscountPct: product?.maxDiscountPct ?? 0,
              variableType: product?.variableType ?? 'none',
              priceCalc: product?.priceCalc ?? 'selling',

              packWeight: product?.packWeight ?? 0,
              weightDescription: product?.weightDescription ?? 'Kg',
              packSize: product?.packSize ?? 0,
              packDescription: product?.packDescription ?? 'None',
              lengthMm: product?.lengthMm ?? 0,
              widthMm: product?.widthMm ?? 0,
              heightMm: product?.heightMm ?? 0,
              prepTimeMinutes: product?.prepTimeMinutes ?? 0,

              scaleItem: product?.scaleItem ?? false,
              labelScaleItem: product?.labelScaleItem ?? false,
              fixedPriceScale: product?.fixedPriceScale ?? false,
              expiresInDays: product?.expiresInDays ?? 0,
            }}
          />
        </div>

        {/* ── Instructions ─────────────────────────────────────────────── */}
        {/* Hidden with CSS, never unmounted — the ticked ids submit as hidden
            inputs, and dropping them would detach every instruction on save. */}
        <div className={tab === 'instructions' ? 'flex flex-col gap-4' : 'hidden'}>
          <Card>
            <SectionTitle icon={<Lightbulb size={16} />}>Instructions</SectionTitle>
            <InstructionsPanel
              groups={instructionGroups}
              attached={attachedInstructions}
            />
          </Card>
        </div>

        {/* ── Suppliers ────────────────────────────────────────────────── */}
        {/* Hidden with CSS, never unmounted — the rows submit as hidden inputs
            and dropping them would unlink every supplier on save. */}
        <div className={tab === 'suppliers' ? 'flex flex-col gap-4' : 'hidden'}>
          <Card>
            <SectionTitle icon={<Truck size={16} />}>Suppliers</SectionTitle>
            <ProductSuppliersPanel links={productSuppliers} />
          </Card>
        </div>

        {/* ── Recipe ───────────────────────────────────────────────────── */}
        {/* Only mounted for a recipe product: its hidden inputs are the whole
            ingredient list, and submitting them from a product that is no
            longer a recipe would write a list the save path then rejects. */}
        {productType === 'recipe' && (
          <div className={tab === 'recipe' ? 'flex flex-col gap-4' : 'hidden'}>
            <Card>
              <SectionTitle icon={<Shapes size={16} />}>Recipe</SectionTitle>
              <RecipePanel
                lines={recipeLines}
                productId={product?.id ?? null}
                isNew={isNew}
                isManufactured={product?.isManufactured ?? false}
                /* Locked once there is history: flipping it would change what
                   the product's past sales meant. updateProduct refuses it
                   too — a disabled control is not a boundary. */
                lockManufactured={!isNew && (product?.stockOnHand ?? 0) !== 0}
              />
            </Card>
          </div>
        )}

        {/* ── Refer ────────────────────────────────────────────────────── */}
        {productType === 'refer' && (
          <div className={tab === 'refer' ? 'flex flex-col gap-4' : 'hidden'}>
            <Card>
              <SectionTitle icon={<ArrowLeftRight size={16} />}>Refer</SectionTitle>
              <ReferPanel link={referLink} productId={product?.id ?? null} isNew={isNew} />
            </Card>
          </div>
        )}

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
                availability={availability}
                onAvailabilityChange={setStoreAvailable}
                onSharesCostChange={setSharesCost}
                onSharesSellingChange={setSharesSelling}
              />
            </Card>
          </div>
        )}

      </form>

      {/* ── Serials ──────────────────────────────────────────────────────── */}
      {/* OUTSIDE the form on purpose. Serials commit on their own — a unit of
          stock must not be lost because an unrelated field failed validation —
          so this panel carries its own <form> elements, and nesting those
          inside the product form would make the browser drop them. */}
      {productType === 'serial' && (
        <div className={tab === 'serials' ? 'flex flex-col gap-4' : 'hidden'}>
          <Card>
            <SectionTitle icon={<Barcode size={16} />}>Serial numbers</SectionTitle>
            <SerialsPanel
              serials={serials}
              productId={product?.id ?? null}
              stockOnHand={product?.stockOnHand ?? 0}
            />
          </Card>
        </div>
      )}
    </div>
  )
}

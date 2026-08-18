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
import ReferWizard from '@/components/ReferWizard'
import SerialsPanel from '@/components/SerialsPanel'
import ProductSuppliersPanel from '@/components/ProductSuppliersPanel'
import type { InstructionGroup } from '@/lib/site/instructions'
import type { RecipeLine } from '@/lib/site/productComposition'
import type { ChainRung } from '@/lib/site/referRange'
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
  referChain,
  serials,
  productSuppliers,
  suggestedCode = null,
  autoCode = false,
  pictureFont = '',
  generalExtras = null,
}: {
  product: Product | null
  /**
   * Panels that belong to the General tab but save on their own — variants and
   * the photo gallery.
   *
   * Passed in rather than rendered here because both are server-composed, and
   * placed by this component rather than by the page because otherwise they sit
   * BELOW the tab strip on every tab: switching to Properties or Recipe still
   * showed the gallery underneath, which reads as though it belongs to whatever
   * tab is open. They stay OUTSIDE <form> — each carries its own form elements
   * and the browser drops a nested one.
   */
  generalExtras?: React.ReactNode
  /**
   * Pre-filled code for a new product, or null when auto-numbering is off.
   * A suggestion only — see lib/site/masterCodes.ts.
   */
  suggestedCode?: string | null
  /** Whether this site numbers products automatically — the refer wizard asks. */
  autoCode?: boolean
  /**
   * The site's typeface for generated till icons — a PICTURE_FONTS id, or ''
   * for "never chosen". Site-wide rather than per product; see
   * lib/generatedPicture.
   */
  pictureFont?: string | null
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
  /** The whole pack ladder this product sits on, bottom rung first. */
  referChain: ChainRung[]
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

  /*
   * What one of a recipe product costs to make.
   *
   * Held here rather than in either panel because it crosses two tabs: the
   * Recipe tab owns the ingredient list that produces it, and the Pricing panel
   * on General shows it and prices against it. Seeded from the saved lines so
   * the figure is right on first paint, then kept current by RecipePanel as
   * rows are edited — change a quantity and the margin moves before you save.
   */
  const [recipeCost, setRecipeCost] = useState(() =>
    recipeLines.reduce((sum, l) => sum + l.qty * (1 + l.wastagePct / 100) * l.unitCostExcl, 0),
  )

  // Only a recipe derives its cost. A refer product points at another product
  // and takes its cost from the target at posting time, but that is one link
  // rather than a sum and the cost box is not how it is set.
  const derivedCost = productType === 'recipe' ? recipeCost : null

  /*
   * Whether to offer the Refer tab.
   *
   * NOT `productType === 'refer'` alone. The BASE of a ladder is an ordinary
   * `normal` product on purpose — createReferRange forces it, because a refer
   * with nothing under it is refused on every sale — so a type check hid the
   * ladder from the single at the bottom, which is the rung people open first
   * and the one a case exists to refill. Being ON a ladder earns the tab, and
   * referChain returns the same ladder from any rung including the base.
   */
  const onReferLadder = productType === 'refer' || referChain.length > 1

  // The refer wizard builds a whole pack range around this product. Only
  // reachable once it is saved, because the range chains onto its id.
  const [wizardOpen, setWizardOpen] = useState(false)

  // The rate the wizard prices against, so its markup column agrees with the
  // Pricing panel's. This product's own rate, or the site default.
  const sellingVatPercent =
    vatRates.find((v) => v.id === product?.sellingVatRateId)?.rate ??
    vatRates.find((v) => v.vatType === 'sales' && v.isDefault)?.rate ??
    0

  const defaultPrices: Record<number, number> = {}
  for (const s of structures) {
    defaultPrices[s.id] = product?.prices.find((p) => p.priceStructureId === s.id)?.sellIncl ?? 0
  }

  const initial = (description.trim()[0] ?? '?').toUpperCase()

  // EDIT_COLUMN, not a literal: this wrapper is what gives the whole screen its
  // width, including the self-saving panels in `generalExtras` that sit after
  // the form but inside this div.
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
            ...(onReferLadder
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
                /* Live state, not the saved record: the generated icon should
                   carry the name the user is typing now, not the one that was
                   last saved. */
                productName={description}
                pictureFont={pictureFont}
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
            /* A recipe's cost is the sum of its ingredients, not a typed
               figure — see the note on recipeCost above. */
            derivedCost={derivedCost}
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
                /* Feeds the Pricing panel on the General tab, so editing an
                   ingredient here moves the cost and margin there. */
                onCostChange={setRecipeCost}
              />
            </Card>
          </div>
        )}

        {/* ── Refer ────────────────────────────────────────────────────── */}
        {onReferLadder && (
          <div className={tab === 'refer' ? 'flex flex-col gap-4' : 'hidden'}>
            <Card>
              <SectionTitle
                icon={<ArrowLeftRight size={16} />}
                action={
                  !isNew && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setWizardOpen(true)}>
                      Build a pack range
                    </Button>
                  )
                }
              >
                Refer
              </SectionTitle>
              {/* Self-saving: adding a pack size creates a product, which
                  cannot wait for the form's Save button. */}
              {product ? (
                <ReferPanel
                  productId={product.id}
                  initialChain={referChain}
                  autoCode={autoCode}
                  onOpenWizard={() => setWizardOpen(true)}
                />
              ) : (
                <p className="p-6 text-sm text-muted">
                  Save the product first, then set up the pack sizes it is sold in.
                </p>
              )}
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

      {/* OUTSIDE the form, like every other self-saving panel here: the wizard
          carries its own inputs and commits its own transaction, and nesting a
          dialog's fields inside this form would submit them with the product. */}
      {product && (
        <ReferWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          vatPercent={sellingVatPercent}
          autoCode={autoCode}
          // Already linked? The range joins that ladder's method rather than
          // picking one — see setReferGroupMethod.
          groupMethod={referChain.find((r) => r.method)?.method ?? null}
          base={{
            productId: product.id,
            description: product.description,
            code: product.code,
            barcode: product.barcode ?? '',
            costExcl: product.lastCost,
            sellIncl: defaultPrices[structures.find((s) => s.isDefault)?.id ?? 0] ?? 0,
            departmentId: product.departmentId,
            brandId: product.brandId,
            purchaseVatRateId: product.purchaseVatRateId,
            sellingVatRateId: product.sellingVatRateId,
          }}
        />
      )}

      {/* ── General tab, continued ───────────────────────────────────────── */}
      {/* Variants and photographs. Rendered after </form> for the same reason
          Serials is — both save on their own and carry their own form elements
          — but hidden with the General tab, because they are part of it. Left
          outside the tab they rendered under every tab at once. */}
      {generalExtras && (
        <div className={tab === 'general' ? 'flex flex-col gap-4' : 'hidden'}>{generalExtras}</div>
      )}

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

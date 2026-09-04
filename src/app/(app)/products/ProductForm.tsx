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
import ExtraBarcodesModal from './ExtraBarcodesModal'
import GenerateBarcodeModal from './GenerateBarcodeModal'
import PropertiesPanel from '@/components/PropertiesPanel'
import InstructionsPanel from '@/components/InstructionsPanel'
import RecipePanel from '@/components/RecipePanel'
import ReferPanel from '@/components/ReferPanel'
import ReferWizard from '@/components/ReferWizard'
import SerialsPanel from '@/components/SerialsPanel'
import ProductSuppliersPanel from '@/components/ProductSuppliersPanel'
import ProductKitchenPanel from '@/components/ProductKitchenPanel'
import ProductReportingPanel, { type ProductReportChoice } from '@/components/ProductReportingPanel'
import { formatMoney } from '@/lib/decimals'
import type { InstructionGroup } from '@/lib/site/instructions'
import type { KitchenPrinter } from '@/lib/site/kitchenPrinters'
import type { RecipeLine } from '@/lib/site/productComposition'
import type { ChainRung } from '@/lib/site/referRange'
import type { Serial } from '@/lib/site/serials'
import type { ProductSupplier } from '@/lib/site/productSuppliers'
import type { ProductBarcode } from '@/lib/site/productBarcodes'
import {
  Button,
  Callout,
  Card,
  EDIT_COLUMN,
  FIELD_LABEL,
  Field,
  FieldMenu,
  Input,
  MenuItem,
  SectionTitle,
  SectionBody,
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
  Wand,
  ArrowLeftRight,
  Printer,
  LineChart,
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
  | 'kitchen'
  | 'suppliers'
  | 'recipe'
  | 'refer'
  | 'serials'
  | 'linked'
  | 'reporting'

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
  ownership = { canEdit: true, ownerName: null },
  instructionGroups,
  attachedInstructions,
  kitchenPrinters,
  attachedKitchenPrinters,
  knownKitchenGroups,
  recipeLines,
  referChain,
  serials,
  productSuppliers,
  canQuickAdjust = false,
  reports = [],
  priceHistory = null,
  suggestedCode = null,
  autoCode = false,
  pictureFont = '',
  generalExtras = null,
  extraBarcodes = [],
  returnTo = null,
}: {
  product: Product | null
  /**
   * The list URL this product was opened from, already validated by the page.
   *
   * Null when it was reached directly — from a search, a link, a bookmark —
   * in which case saving falls back to the product itself, exactly as before.
   */
  returnTo?: string | null
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
   * The alias barcodes already on file, for the chevron beside the Barcode
   * field. Read on the server with the rest of the product; empty on the
   * new-product screen, which has no product to hang an alias off yet.
   */
  extraBarcodes?: ProductBarcode[]
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
  /**
   * Whether this store may change what the product IS.
   *
   * Defaulted for the NEW-product screen and any caller predating this: a
   * product being created is always this store's own.
   */
  ownership?: { canEdit: boolean; ownerName: string | null }
  /** Every active instruction in the library, for the Instructions tab. */
  instructionGroups: InstructionGroup[]
  /** Ids of the instructions this product currently asks. */
  attachedInstructions: number[]
  /** Every active kitchen printer, for the Kitchen tab. Empty hides the tab. */
  kitchenPrinters: KitchenPrinter[]
  /** Printer ids this product already routes to. */
  attachedKitchenPrinters: number[]
  /** Groups already in use elsewhere, offered as suggestions. */
  knownKitchenGroups: string[]
  /** The ingredient list, for a recipe product. Empty otherwise. */
  recipeLines: RecipeLine[]
  /** What a refer product draws its stock from, or null. */
  /** The whole pack ladder this product sits on, bottom rung first. */
  referChain: ChainRung[]
  /** The individual units of a serial product. Empty otherwise. */
  serials: Serial[]
  /** Who this product is bought from. */
  productSuppliers: ProductSupplier[]
  /**
   * Whether this user may post a stock adjustment — the inventory_advanced
   * module AND stock.adjust. Resolved by the page: a client component cannot
   * read an entitlement, and the action checks it again anyway.
   */
  canQuickAdjust?: boolean
  /**
   * The reports offered on the Reporting tab, already filtered to what this
   * user may run. Empty hides the tab — an empty tab is worse than no tab.
   */
  reports?: ProductReportChoice[]
  /** The price-history card, which now lives on the Reporting tab. */
  priceHistory?: React.ReactNode
}) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(saveProductAction, {
    error: null,
  })

  const isNew = product === null
  const [description, setDescription] = useState(product?.description ?? '')

  /* The barcode is CONTROLLED, unlike the other overview fields, because the
     generator writes into it: an uncontrolled input with a defaultValue cannot
     be changed from outside without reaching for a ref, and the dialog would
     be writing to the DOM behind React's back.

     The alias rows are held here too, so the chevron's menu can show a count
     without the dialog being open — a product WITH extra barcodes says so
     before anyone opens it, which is what makes hiding them behind a menu
     safe. Kept in sync by the dialog rather than re-read: each add/remove is
     already its own round trip.  */
  const [barcode, setBarcode] = useState(product?.barcode ?? '')
  const [aliases, setAliases] = useState<ProductBarcode[]>(extraBarcodes)
  const [aliasesOpen, setAliasesOpen] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  // Existing rows may still hold a hex from before these became tokens;
  // tileClass() falls back to the first swatch rather than rendering nothing.
  const [color, setColor] = useState(product?.imageColor ?? TILE_SWATCHES[0].token)

  // The sharing toggles live here rather than in either panel: the pricing
  // tables need them to decide which rows are editable, and the linked-stores
  // card owns the controls. One source of truth, read by both.
  const [sharesCost, setSharesCost] = useState(defaultSharesCost)
  const [sharesSelling, setSharesSelling] = useState(defaultSharesSelling)

  // Open to start with: the fold exists to put a section you are done with out
  // of the way, not to hide stock levels until somebody thinks to look.
  const [inventoryOpen, setInventoryOpen] = useState(true)

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

  // Bumped when the wizard creates a range, so the Refer panel re-reads the
  // ladder. The wizard is a sibling of that panel — it commits its own
  // transaction and hands back ids, not a chain — so without this the pack
  // sizes only showed up after saving the product, which navigated.
  const [referRefresh, setReferRefresh] = useState(0)

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

  /* Defined once and placed by the department picker, which is the only thing
     that knows how many levels are on screen — see its `trailing` prop. No
     max-w here: it is a grid cell now, and the column sets the width. */
  const brandField = (
    <Field label="Brand">
      <Select name="brandId" defaultValue={product?.brandId ?? ''}>
        <option value="">&lt;None&gt;</option>
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
    </Field>
  )

  // EDIT_COLUMN, not a literal: this wrapper is what gives the whole screen its
  // width, including the self-saving panels in `generalExtras` that sit after
  // the form but inside this div.
  return (
    <div className={`flex ${EDIT_COLUMN} flex-col gap-4`}>
      {/*
        ── ENTER DOES NOT SAVE ──────────────────────────────────────────────

        A form with a single submit button submits on Enter from any input —
        the browser's "implicit submission". On a one-question form that is a
        convenience. Here it is a trap: this form is seven tabs deep, the tab
        is client state, and saving reloads the page — so Enter in a Recipe
        quantity box saved the product and dropped the user back on General,
        looking like the app had navigated away by itself.

        The cost of getting it wrong is asymmetric. Nobody types a quantity and
        expects the whole product to commit; but somebody halfway through a
        recipe, tabbing between quantity and wastage, hits Enter out of habit
        constantly. Saving is a deliberate act on a form this size, and it has
        a deliberate button in the header.

        Blocked at the FORM rather than on each input, because the bug is the
        form's rule, not any one field's — a per-input handler would be thirty
        copies of this and would still miss the next field somebody adds.

        Three deliberate exceptions:
          - textarea, where Enter is a newline and never submitted anything.
          - anything that has already handled the key: the Combobox picks the
            highlighted ingredient with Enter and calls preventDefault itself,
            so a defaultPrevented event is one that has done its job.
          - a real submit button focused and activated with Enter, which is a
            press of that button rather than implicit submission.
        The header's Save is a <button type="submit" form="product-form">, which
        does not travel through this handler at all — it stays unaffected.
      */}
      <form
        id={FORM_ID}
        action={formAction}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.defaultPrevented) return
          const el = e.target as HTMLElement
          if (el.tagName === 'TEXTAREA') return
          if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit') return
          e.preventDefault()
        }}
        className="flex flex-col gap-4"
      >
        {product && <input type="hidden" name="id" value={product.id} />}

        {/* The list this product was opened from, so saving returns to it with
            its filters intact instead of dropping onto the bare catalogue.
            Carried through the form because the redirect happens in the server
            action, which sees only what the FormData brings it. */}
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}

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

        {/* A product belongs to the store whose catalogue it was created in.
            Said BEFORE the fields rather than discovered on save: a form that
            silently refuses is worse than one that explains itself first.

            What this store CAN still do is spelled out, because "read only"
            alone reads as "this product is not yours" — it stocks it, prices
            it where prices are not shared, and sells it. */}
        {!ownership.canEdit && (
          <Callout tone="brand" title={`Managed by ${ownership.ownerName ?? 'another store'}`}>
            You can stock this product, set your own prices where prices are not
            shared, and sell it. Its details are changed at{' '}
            {ownership.ownerName ?? 'the store that created it'}.
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
            /* Only where the shop has somewhere to send food. A restaurant sees
               it; a hardware shop that has never set up a printer is not asked
               a question it has no answer to. */
            ...(kitchenPrinters.length > 0
              ? [
                  {
                    value: 'kitchen',
                    label: 'Kitchen',
                    icon: <Printer size={16} />,
                    count: attachedKitchenPrinters.length || undefined,
                  },
                ]
              : []),
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
            /* Edit only. A product being created has no history to report on,
               and every one of these reads its saved code or id. */
            ...(!isNew && reports.length > 0
              ? [{ value: 'reporting', label: 'Reporting', icon: <LineChart size={16} /> }]
              : []),
          ]}
          value={tab}
          onChange={(next) => setTab(next as TabValue)}
        />

        {/* Hidden rather than unmounted for the same reason as the linked tab:
            every field below is part of this one form and must still submit. */}
        {/* Disabled rather than hidden when another store owns this product: a
            branch still needs to SEE what it is selling. Only the two tabs that
            define what the product IS are locked — Pricing stays editable,
            because a branch owns its own cost and selling price wherever those
            are not shared. */}
        <fieldset disabled={!ownership.canEdit} className="contents">
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

                {/* The chevron is JOINED to the field on purpose: everything
                    behind it acts on this barcode, and a separate button an inch
                    away would read as an unrelated control. See FieldMenu. */}
                <Field label="Barcode">
                  <FieldMenu triggerLabel="More barcode options">
                    <Input
                      name="barcode"
                      value={barcode}
                      onChange={(e) => setBarcode(e.target.value)}
                      maxLength={64}
                      placeholder="Scan or type"
                    />
                    {(close) => (
                      <>
                        {/* Edit only. An alias is a row pointing at a product
                            id, and a product being created has no id yet — the
                            entry is offered once there is something to attach
                            it to. */}
                        <MenuItem
                          disabled={isNew}
                          onClick={() => {
                            close()
                            setAliasesOpen(true)
                          }}
                        >
                          <Barcode size={15} />
                          Extra barcodes
                          {aliases.length > 0 && (
                            <span className="numeric ml-auto text-xs text-muted">
                              {aliases.length}
                            </span>
                          )}
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            close()
                            setGeneratorOpen(true)
                          }}
                        >
                          <Wand size={15} />
                          Generate barcode
                        </MenuItem>
                      </>
                    )}
                  </FieldMenu>
                </Field>
              </div>

              {/* Till tile and product type share a row rather than stacking.
                  The tile is a short block that leaves the right half of the
                  card empty, and product type sat beneath it as a full-width
                  band — two rows spent saying what fits in one. Paired, they
                  read as one answer to "what IS this product": how it looks,
                  and how it behaves.

                  Two columns only from sm up — below that the swatch grid and
                  the type panel each need the full width. */}
              <div className="grid items-start gap-5 sm:grid-cols-2">
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
                  /* The tile is a live preview of the till, so it takes what the
                     till shows: the name as it is being typed, the code, the
                     default-structure price, and the department whose tone a
                     product with no colour of its own falls back to. */
                  description={description}
                  code={product?.code ?? suggestedCode ?? ''}
                  price={formatMoney(
                    defaultPrices[structures.find((s) => s.isDefault)?.id ?? 0] ?? 0,
                  )}
                  departmentId={product?.departmentId ?? null}
                />

                {/* Product type, moved up from the foot of the tab.
                    It sat last, below Pricing and Inventory, which put the
                    choice that DECIDES whether Recipe, Refer and Serials tabs
                    exist at all after everything it governs. It belongs with
                    identity.

                    It carries its own caption now: the panel renders the type's
                    NAME ("Standard product"), never the words "Product type" —
                    those came from the card heading this replaced, so without a
                    label here the control lost the only thing saying what it
                    is. */}
                <div>
                  <span className={FIELD_LABEL}>Product type</span>
                  <ProductTypePanel
                    defaultValue={product?.productType ?? DEFAULT_PRODUCT_TYPE}
                    onChange={setProductType}
                    onSetupClick={(type) => {
                      const target = SETUP_TAB[type]
                      if (target) setTab(target)
                    }}
                  />
                </div>
              </div>

              <Field label="Extra description">
                <RichText
                  name="extraDescription"
                  defaultValue={product?.extraDescription ?? ''}
                  placeholder="Longer description, ingredients, specifications…"
                />
              </Field>

              {/* Three across rather than four: at five and six entries a
                  four-column grid leaves a ragged orphan row, and these read as
                  pairs anyway — what a person did, what the stock did. */}
              {product && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ['Last edit date', product.lastEditDate],
                      ['Last purchase', product.lastPurchaseDate],
                      ['Last sold', product.lastSoldDate],
                      /* Counted and adjusted are DIFFERENT events and both are
                         shown: posting a stock take stamps last_adjust_date too
                         when the count disagreed, so without the count beside it
                         a stock take looks like someone adjusted the figure by
                         hand. */
                      ['Last stock take', product.lastStockTakeDate],
                      ['Last adjusted', product.lastAdjustDate],
                      ['Last transfer', product.lastTransferDate],
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
              {/* Brand rides IN the picker's grid rather than sitting under it,
                  so it fills the spare column on a shallow tree instead of
                  costing a whole row of height. On a 3-level tree it wraps
                  underneath, which is where it used to live anyway. */}
              {/* No empty-state branch: the picker handles an empty tree by
                  showing one select holding nothing but <Create new>, which is
                  how the FIRST department gets made without leaving a
                  half-filled product form. */}
              {departments.length === 0 && (
                <p className="text-sm text-muted">
                  No departments exist yet — pick <span className="text-ink-2">&lt;Create
                  new&gt;</span> below to add one. Products can also be saved without one.
                </p>
              )}
              <DepartmentPicker
                name="departmentId"
                departments={departments}
                defaultValue={product?.departmentId ?? null}
                trailing={brandField}
              />
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
            <SectionTitle
              icon={<Warehouse size={16} />}
              open={inventoryOpen}
              onToggle={() => setInventoryOpen((v) => !v)}
            >
              Inventory
            </SectionTitle>
            <SectionBody open={inventoryOpen}>
            <LocationStockPanel
              isNew={isNew}
              productId={product?.id ?? null}
              productName={description}
              /* A serial product is excluded here rather than refused in the
                 dialog: a quantity-only adjustment cannot say WHICH units left,
                 so offering the button would promise something it cannot do.
                 The action refuses it too — this just stops the offer. */
              canAdjust={canQuickAdjust && productType !== 'serial'}
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
            </SectionBody>
          </Card>

        </div>
        </fieldset>

        {/* ── Linked stores ────────────────────────────────────────────── */}
        {/* ── Properties ───────────────────────────────────────────────── */}
        {/* Hidden with CSS, never unmounted — the switches submit through hidden
            inputs, and dropping them would save every property as off. */}
        <fieldset disabled={!ownership.canEdit} className="contents">
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
        </fieldset>

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

        {/* ── Kitchen ──────────────────────────────────────────────────── */}
        {/* Hidden with CSS, never unmounted — the ticked printer ids and the
            group submit as form fields, and dropping them would unroute this
            product on every save made from another tab. */}
        {kitchenPrinters.length > 0 && (
          <div className={tab === 'kitchen' ? 'flex flex-col gap-4' : 'hidden'}>
            <Card>
              <SectionTitle icon={<Printer size={16} />}>Kitchen printing</SectionTitle>
              <ProductKitchenPanel
                printers={kitchenPrinters}
                attached={attachedKitchenPrinters}
                group={product?.kitchenGroup ?? ''}
                knownGroups={knownKitchenGroups}
              />
            </Card>
          </div>
        )}

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
                  refreshToken={referRefresh}
                  // What this product IS, for the panel to name itself as the
                  // base before anything is linked — the chain is empty then,
                  // so it cannot read its own description off it.
                  self={{ description: product.description, code: product.code }}
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

      {/* OUTSIDE the form on purpose. Reporting submits nothing — it reads — and
          its dialog carries a table and a Close button. Nesting that in the
          product form would make every click inside it a candidate for
          submitting the product. */}
      {product && reports.length > 0 && (
        <div className={tab === 'reporting' ? 'flex flex-col gap-4' : 'hidden'}>
          <ProductReportingPanel
            productId={product.id}
            reports={reports}
            priceHistory={priceHistory}
          />
        </div>
      )}

      {/* OUTSIDE the form, like every other self-saving panel here: the wizard
          carries its own inputs and commits its own transaction, and nesting a
          dialog's fields inside this form would submit them with the product. */}
      {product && (
        <ReferWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          // The range is already committed by the time this fires. Telling the
          // panel to re-read is what puts it on screen — the products exist
          // either way, so a missed refresh looked like the wizard had done
          // nothing until the product was saved.
          onCreated={() => setReferRefresh((n) => n + 1)}
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
      {/* The two barcode dialogs the chevron opens. Outside <form> for the
          same reason the wizard is: the alias dialog carries its own inputs and
          saves on its own, and a nested form is dropped by the browser. */}
      {product && (
        <ExtraBarcodesModal
          open={aliasesOpen}
          onClose={() => setAliasesOpen(false)}
          productId={product.id}
          rows={aliases}
          onRowsChange={setAliases}
        />
      )}

      <GenerateBarcodeModal
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        /* The LIVE code field, not the saved product: on a new product the code
           being typed now is the only one there is, and on an existing one it
           is the same value anyway. */
        productCode={product?.code ?? suggestedCode ?? ''}
        currentBarcode={barcode}
        onGenerated={setBarcode}
      />

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

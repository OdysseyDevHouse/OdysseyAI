'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  BulkActionBar,
  BulkOptionsDialog,
  Button,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  SwatchPicker,
  useToast,
  type BulkOptionGroup,
} from '@/components/ui'
import type { ProductBulkChange } from '@/lib/site/products'
import { bulkUpdateProductsAction } from './actions'
import { useProductColumns } from './ProductColumnsButton'
import ProductsTable from './ProductsTable'

/**
 * The interactive shell around the products table.
 *
 * Mirrors CustomerListClient: the page above stays a Server Component that
 * reads the URL and queries, and only selection — which never needs to survive
 * a reload — lives here in React state.
 *
 * The one departure from customers and suppliers is the action catalogue.
 * Products has twenty-odd bulk changes, far too many for the selection bar, so
 * the bar holds a single "Bulk options" button that opens the dialog.
 */

export type ProductBulkLookups = {
  departments: { id: number; label: string }[]
  brands: { id: number; name: string }[]
  sellingVatRates: { id: number; label: string }[]
  purchaseVatRates: { id: number; label: string }[]
  instructionGroups: { id: number; name: string }[]
  locations: { id: number; name: string; isMain: boolean }[]
}

type BulkKind = ProductBulkChange['kind']

/** Which modal is open, or the dialog, or nothing. */
type Stage = { view: 'options' } | { view: 'form'; kind: BulkKind } | null

export default function ProductListClient({
  lookups,
  canDelete,
  storeColumns,
  ...tableProps
}: {
  lookups: ProductBulkLookups
  /** Whether this role holds products.delete — decides if delete is offered. */
  canDelete: boolean
  /**
   * The columns THIS STORE shows, from list_columns — or the list's own default
   * when it has never chosen. See lib/site/listColumns.ts.
   *
   * The Columns button in the toolbar takes the same value and resolves it with
   * the same hook, so the control and the table always agree.
   */
  storeColumns: string[]
} & Omit<
  Parameters<typeof ProductsTable>[0],
  'selectedKeys' | 'onSelectionChange' | 'visibleColumns'
>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [stage, setStage] = useState<Stage>(null)
  const [recent, setRecent] = useState<BulkKind[]>([])
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const count = selected.size

  /* The same hook the Columns button in the toolbar uses, so the control and
     the table cannot disagree about what is shown. See ProductColumnsButton. */
  const { visible: visibleColumns } = useProductColumns(storeColumns)

  function runBulk(change: ProductBulkChange) {
    const ids = [...selected].map(Number)
    startTransition(async () => {
      const result = await bulkUpdateProductsAction(ids, change)
      setStage(null)

      // Remember what was used, most recent first, so the shop that only ever
      // moves departments finds it at the top next time.
      setRecent((prev) => [change.kind, ...prev.filter((k) => k !== change.kind)].slice(0, 4))

      if (result.updated === 0) {
        const reason = result.skipped[0]?.reason
        toast.error(reason ? `Nothing updated — ${reason.toLowerCase()}` : 'Nothing was updated.')
        return
      }

      if (result.skipped.length > 0) {
        // Name the refusals: "2 skipped" with no list leaves the user unable to
        // tell whether the two that mattered went through.
        const names = result.skipped
          .filter((s) => s.code)
          .map((s) => s.code)
          .slice(0, 3)
          .join(', ')
        toast.info(
          `${result.updated} updated, ${result.skipped.length} skipped${names ? ` — ${names}` : ''}`,
        )
      } else {
        toast.success(`${result.updated} product${result.updated === 1 ? '' : 's'} updated`)
      }

      setSelected(new Set())
      router.refresh()
    })
  }

  return (
    <>
      <BulkActionBar count={count} onClear={() => setSelected(new Set())}>
        {/* Shelf labels for the picked products — a print run, not a change,
            so it opens the sheet rather than a form. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || count === 0}
          onClick={() => window.open(`/labels/a4?ids=${[...selected].join(',')}`, '_blank')}
        >
          <Icons.Printer size={15} />
          Print labels
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setStage({ view: 'options' })} disabled={pending}>
          <Icons.SlidersHorizontal size={15} />
          Bulk options
        </Button>
      </BulkActionBar>

      <ProductsTable
        {...tableProps}
        visibleColumns={visibleColumns}
        selectedKeys={selected}
        onSelectionChange={setSelected}
      />

      <BulkOptionsDialog
        open={stage?.view === 'options'}
        onClose={() => setStage(null)}
        onPick={(kind) => setStage({ view: 'form', kind })}
        groups={optionGroups(canDelete)}
        count={count}
        noun="product"
        recent={recent}
      />

      <BulkForms
        kind={stage?.view === 'form' ? stage.kind : null}
        count={count}
        lookups={lookups}
        pending={pending}
        /* Back to the catalogue rather than closing outright: picking the wrong
           action from twenty is easy, and starting the selection again is not. */
        onClose={() => setStage({ view: 'options' })}
        onApply={runBulk}
      />
    </>
  )
}

/* ── The catalogue ───────────────────────────────────────────────────────── */

/**
 * Every bulk action, grouped the way the old system grouped them.
 *
 * Split by what the change touches — the product record itself versus the
 * per-till behaviour on its properties tab — because that is how someone
 * looking for one of twenty actions narrows down where to look.
 */
function optionGroups(canDelete: boolean): BulkOptionGroup<BulkKind>[] {
  const product: BulkOptionGroup<BulkKind> = {
    title: 'Product',
    options: [
      { key: 'department', label: 'Move to department', icon: <Icons.Landmark size={15} /> },
      { key: 'brand', label: 'Change brand', icon: <Icons.Tags size={15} /> },
      {
        key: 'instructionGroup',
        label: 'Link instruction group',
        icon: <Icons.ClipboardList size={15} />,
        keywords: 'modifier options unlink remove',
      },
      { key: 'color', label: 'Change product colour', icon: <Icons.Palette size={15} />, keywords: 'tile color swatch' },
      { key: 'sellingVat', label: 'Change selling tax', icon: <Icons.Percent size={15} />, keywords: 'vat rate' },
      { key: 'purchaseVat', label: 'Change purchase tax', icon: <Icons.Percent size={15} />, keywords: 'vat rate' },
    ],
  }

  const properties: BulkOptionGroup<BulkKind> = {
    title: 'Properties',
    options: [
      { key: 'minLevel', label: 'Change minimum level', icon: <Icons.SortDesc size={15} />, keywords: 'reorder stock' },
      { key: 'maxLevel', label: 'Change maximum level', icon: <Icons.SortAsc size={15} />, keywords: 'reorder stock' },
      { key: 'visibleInPos', label: 'Change visible on POS', icon: <Icons.Eye size={15} /> },
      { key: 'showOnline', label: 'Change visible on e-store', icon: <Icons.Globe size={15} />, keywords: 'online shop web' },
      { key: 'changeDescription', label: 'Ask item description', icon: <Icons.List size={15} /> },
      { key: 'askPriceAtSale', label: 'Ask item price', icon: <Icons.Tag size={15} />, keywords: 'sq' },
      { key: 'allowFractions', label: 'Change decimal fractions', icon: <Icons.Hash size={15} /> },
      { key: 'scaleItem', label: 'Change scale item', icon: <Icons.Scale size={15} /> },
      { key: 'labelScaleItem', label: 'Change label scale item', icon: <Icons.Scale size={15} /> },
      { key: 'maxDiscountPct', label: 'Change max discount', icon: <Icons.Percent size={15} /> },
      { key: 'expiresInDays', label: 'Product expiry days', icon: <Icons.CalendarClock size={15} /> },
      { key: 'packSize', label: 'Change pack size', icon: <Icons.Package size={15} /> },
      { key: 'packDescription', label: 'Change pack description', icon: <Icons.PackageOpen size={15} /> },
      { key: 'packWeight', label: 'Change pack weight', icon: <Icons.Scale size={15} /> },
      { key: 'weightDescription', label: 'Change pack weight description', icon: <Icons.Scale size={15} /> },
      { key: 'priceCalc', label: 'Change price calculation', icon: <Icons.Calculator size={15} /> },
    ],
  }

  const lifecycle: BulkOptionGroup<BulkKind> = {
    title: 'Lifecycle',
    options: [
      { key: 'archive', label: 'Archive or restore', icon: <Icons.Archive size={15} /> },
      ...(canDelete
        ? [
            {
              key: 'delete' as const,
              label: 'Delete products',
              icon: <Icons.Trash size={15} />,
              tone: 'danger' as const,
            },
          ]
        : []),
    ],
  }

  return [product, properties, lifecycle]
}

/* ── The per-action forms ────────────────────────────────────────────────── */

/** The on/off changes, which all render the same two-option select. */
const BOOLEAN_FORMS: Partial<Record<BulkKind, { title: string; label: string; hint?: string }>> = {
  visibleInPos: {
    title: 'Change visible on POS',
    label: 'Visible on POS',
    hint: 'Hidden products stay on file and keep their history — they just leave the till.',
  },
  showOnline: { title: 'Change visible on e-store', label: 'Visible on e-store' },
  changeDescription: {
    title: 'Ask item description',
    label: 'Ask for a description at the till',
  },
  askPriceAtSale: { title: 'Ask item price', label: 'Ask for a price at the till' },
  allowFractions: {
    title: 'Change decimal fractions',
    label: 'Allow decimal quantities',
    hint: 'On for anything sold by weight or length; off for whole units.',
  },
  scaleItem: { title: 'Change scale item', label: 'Is a scale item' },
  labelScaleItem: { title: 'Change label scale item', label: 'Is a label scale item' },
}

/** The plain-number changes. */
const NUMBER_FORMS: Partial<
  Record<BulkKind, { title: string; label: string; hint?: string; step?: string }>
> = {
  maxDiscountPct: {
    title: 'Change max discount',
    label: 'Maximum discount (%)',
    hint: '0–100. Zero means no discount may be given.',
  },
  expiresInDays: {
    title: 'Product expiry days',
    label: 'Expires after (days)',
    hint: 'Days from receipt. Zero means it does not expire.',
  },
  packSize: { title: 'Change pack size', label: 'Pack size', step: '0.001' },
  packWeight: { title: 'Change pack weight', label: 'Pack weight', step: '0.0001' },
}

/** The short free-text changes. */
const TEXT_FORMS: Partial<Record<BulkKind, { title: string; label: string; placeholder: string }>> =
  {
    packDescription: {
      title: 'Change pack description',
      label: 'Pack description',
      placeholder: 'e.g. Case of 12',
    },
    weightDescription: {
      title: 'Change pack weight description',
      label: 'Weight description',
      placeholder: 'e.g. Kg',
    },
  }

function BulkForms({
  kind,
  count,
  lookups,
  pending,
  onClose,
  onApply,
}: {
  kind: BulkKind | null
  count: number
  lookups: ProductBulkLookups
  pending: boolean
  onClose: () => void
  onApply: (change: ProductBulkChange) => void
}) {
  const [bool, setBool] = useState(true)
  const [number, setNumber] = useState(0)
  const [text, setText] = useState('')
  const [id, setId] = useState('')
  const [locationId, setLocationId] = useState(
    () => String(lookups.locations.find((l) => l.isMain)?.id ?? lookups.locations[0]?.id ?? ''),
  )
  const [color, setColor] = useState<string | null>(null)
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [priceCalc, setPriceCalc] = useState<'selling' | 'markup'>('selling')
  const [archived, setArchived] = useState(true)

  const noun = `${count} product${count === 1 ? '' : 's'}`

  /** Footer shared by every form: cancel goes back, apply names the scope. */
  const footer = (change: () => ProductBulkChange, tone: 'primary' | 'danger' = 'primary') => (
    <>
      <Button variant="ghost" onClick={onClose} disabled={pending}>
        Back
      </Button>
      <Button variant={tone} onClick={() => onApply(change())} disabled={pending}>
        {pending ? 'Applying…' : `Apply to ${noun}`}
      </Button>
    </>
  )

  const shell = (
    title: string,
    body: ReactNode,
    change: () => ProductBulkChange,
    tone: 'primary' | 'danger' = 'primary',
  ) => (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={`Applies to ${noun}.`}
      size="sm"
      footer={footer(change, tone)}
    >
      {body}
    </Modal>
  )

  if (!kind) return null

  const boolForm = BOOLEAN_FORMS[kind]
  if (boolForm) {
    return shell(
      boolForm.title,
      <Field label={boolForm.label} hint={boolForm.hint}>
        <Select value={bool ? 'yes' : 'no'} onChange={(e) => setBool(e.target.value === 'yes')}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      </Field>,
      () => ({ kind, value: bool }) as ProductBulkChange,
    )
  }

  const numForm = NUMBER_FORMS[kind]
  if (numForm) {
    return shell(
      numForm.title,
      <Field label={numForm.label} hint={numForm.hint}>
        <NumberInput
          value={number}
          step={numForm.step}
          onChange={(e) => setNumber(Number(e.target.value) || 0)}
        />
      </Field>,
      () => ({ kind, value: number }) as ProductBulkChange,
    )
  }

  const textForm = TEXT_FORMS[kind]
  if (textForm) {
    return shell(
      textForm.title,
      <Field label={textForm.label} hint="24 characters or fewer.">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={textForm.placeholder}
          maxLength={24}
        />
      </Field>,
      () => ({ kind, value: text }) as ProductBulkChange,
    )
  }

  switch (kind) {
    case 'department':
      return shell(
        'Move to department',
        <Field label="Department" hint="Leave blank to clear it.">
          <Select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">— No department —</option>
            {lookups.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
        </Field>,
        () => ({ kind: 'department', departmentId: id ? Number(id) : null }),
      )

    case 'brand':
      return shell(
        'Change brand',
        <Field label="Brand" hint="Leave blank to clear it.">
          <Select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">— No brand —</option>
            {lookups.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>,
        () => ({ kind: 'brand', brandId: id ? Number(id) : null }),
      )

    case 'sellingVat':
    case 'purchaseVat':
      return shell(
        kind === 'sellingVat' ? 'Change selling tax' : 'Change purchase tax',
        <Field label="Tax rate" hint="Leave blank to fall back to the default rate.">
          <Select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">— Use the default —</option>
            {(kind === 'sellingVat' ? lookups.sellingVatRates : lookups.purchaseVatRates).map(
              (rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.label}
                </option>
              ),
            )}
          </Select>
        </Field>,
        () => ({ kind, vatRateId: id ? Number(id) : null }) as ProductBulkChange,
      )

    case 'instructionGroup':
      return shell(
        'Link instruction group',
        <div className="flex flex-col gap-4">
          <Field label="Instruction group">
            <Select value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">— Choose a group —</option>
              {lookups.instructionGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Action"
            hint="Adding keeps each product's existing groups and their order."
          >
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'remove')}>
              <option value="add">Add this group</option>
              <option value="remove">Remove this group</option>
            </Select>
          </Field>
        </div>,
        () => ({ kind: 'instructionGroup', groupId: Number(id), mode }),
      )

    case 'color':
      return shell(
        'Change product colour',
        <Field label="Tile colour" hint="Shown on the till tile and in reports.">
          <SwatchPicker value={color} onChange={setColor} />
        </Field>,
        () => ({ kind: 'color', imageColor: color }),
      )

    case 'minLevel':
    case 'maxLevel':
      return shell(
        kind === 'minLevel' ? 'Change minimum level' : 'Change maximum level',
        <div className="flex flex-col gap-4">
          {/* Levels are per location, not per product — a warehouse and a shop
              floor need different reorder points, so this cannot be implied. */}
          <Field label="Stock location" hint="Reorder levels are set per location.">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {lookups.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.isMain ? ' (main)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={kind === 'minLevel' ? 'Minimum level' : 'Maximum level'}>
            <NumberInput
              value={number}
              step="0.001"
              onChange={(e) => setNumber(Number(e.target.value) || 0)}
            />
          </Field>
        </div>,
        () => ({ kind, locationId: Number(locationId), value: number }) as ProductBulkChange,
      )

    case 'priceCalc':
      return shell(
        'Change price calculation',
        <Field
          label="When the cost changes"
          hint="Which figure survives a cost change — the other is recalculated."
        >
          <Select
            value={priceCalc}
            onChange={(e) => setPriceCalc(e.target.value as 'selling' | 'markup')}
          >
            <option value="selling">Hold the selling price, let margin move</option>
            <option value="markup">Hold the margin, move the selling price</option>
          </Select>
        </Field>,
        () => ({ kind: 'priceCalc', value: priceCalc }),
      )

    case 'archive':
      return shell(
        'Archive or restore',
        <Field
          label="Archive state"
          hint="Archived products keep every document and movement — they come off the till only."
        >
          <Select
            value={archived ? 'archive' : 'restore'}
            onChange={(e) => setArchived(e.target.value === 'archive')}
          >
            <option value="archive">Archive</option>
            <option value="restore">Restore</option>
          </Select>
        </Field>,
        () => ({ kind: 'archive', archived }),
      )

    case 'delete':
      return shell(
        'Delete products',
        <p>
          This removes {noun} permanently. Anything that has been sold or moved is archived
          instead, so its documents stay readable — you will be told which.
        </p>,
        () => ({ kind: 'delete' }),
        'danger',
      )

    default:
      return null
  }
}

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  ConfirmModal,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  Modal,
  NumberInput,
  Select,
  SettingRow,
  Switch,
  Tabs,
  useToast,
} from '@/components/ui'
import type {
  VatRateRow,
  VatRateInput,
  VatType,
  PriceStructureRow,
  PriceStructureInput,
} from '@/lib/site/pricingSetup'
import {
  saveVatRateAction,
  deleteVatRateAction,
  savePriceStructureAction,
  deletePriceStructureAction,
  reorderPriceStructuresAction,
  type PricingActionResult,
} from './actions'
import RepriceModal from './RepriceModal'
import type { EndingDirection } from '@/lib/repricing'

/**
 * Two lists, one screen, switched by tab.
 *
 * Both are short (a site has one or two price tiers and a handful of rates), so
 * they are SettingRow lists rather than DataTables — the usage counts and the
 * default/off badges matter more here than sorting ever would.
 */
type Tab = 'structures' | 'vat'

export default function PricingClient({
  vatRates,
  structures,
  departments,
  brands,
  defaultEndingDirection,
}: {
  vatRates: VatRateRow[]
  structures: PriceStructureRow[]
  departments: { id: number; name: string }[]
  brands: { id: number; name: string }[]
  defaultEndingDirection: EndingDirection
}) {
  const [tab, setTab] = useState<Tab>('structures')
  const [repricing, setRepricing] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  // Modal state, one pair per list.
  const [editingStructure, setEditingStructure] = useState<PriceStructureRow | null>(null)
  const [addingStructure, setAddingStructure] = useState(false)
  const [deletingStructure, setDeletingStructure] = useState<PriceStructureRow | null>(null)

  const [editingVat, setEditingVat] = useState<VatRateRow | null>(null)
  const [addingVat, setAddingVat] = useState<VatType | null>(null)
  const [deletingVat, setDeletingVat] = useState<VatRateRow | null>(null)

  function run(work: () => Promise<PricingActionResult>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditingStructure(null)
        setAddingStructure(false)
        setDeletingStructure(null)
        setEditingVat(null)
        setAddingVat(null)
        setDeletingVat(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...structures]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    run(() => reorderPriceStructuresAction(next.map((s) => s.id)))
  }

  const salesRates = vatRates.filter((r) => r.vatType === 'sales')
  const purchaseRates = vatRates.filter((r) => r.vatType === 'purchase')

  return (
    <>
      <Tabs<Tab>
        items={[
          { value: 'structures', label: 'Price types', icon: <Icons.Tag size={16} />, count: structures.length },
          { value: 'vat', label: 'VAT rates', icon: <Icons.Percent size={16} />, count: vatRates.length },
        ]}
        value={tab}
        onChange={setTab}
        aria-label="Pricing setup sections"
      />

      {tab === 'structures' ? (
        <Card>
          <CardHeader
            title="Price types"
            description="Each product can hold one selling price per type. Customer groups and the online store pick which one they sell at; the till uses the customer's, falling back to the default."
            action={
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setRepricing(true)} disabled={pending}>
                  <Icons.Percent size={15} />
                  Bulk reprice
                </Button>
                <Button variant="primary" onClick={() => setAddingStructure(true)} disabled={pending}>
                  <Icons.Plus size={15} />
                  Add price type
                </Button>
              </div>
            }
          />
          <div>
            {structures.map((structure, index) => (
              <SettingRow
                key={structure.id}
                icon={<Icons.Tag size={16} />}
                label={structure.name}
                description={describeStructure(structure)}
              >
                <div className="flex items-center gap-1.5">
                  {structure.isDefault && <Badge tone="brand">Default</Badge>}
                  {!structure.isActive && <Badge tone="neutral">Off</Badge>}
                  <Button
                    variant="bare"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${structure.name} up`}
                    disabled={index === 0 || pending}
                    onClick={() => move(index, -1)}
                  >
                    <Icons.ChevronUp size={15} />
                  </Button>
                  <Button
                    variant="bare"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${structure.name} down`}
                    disabled={index === structures.length - 1 || pending}
                    onClick={() => move(index, 1)}
                  >
                    <Icons.ChevronDown size={15} />
                  </Button>
                  <Menu label="More" variant="ghost">
                    <MenuItem onClick={() => setEditingStructure(structure)}>
                      <Icons.Pencil size={15} />
                      Edit
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      disabled={pending}
                      onClick={() => setDeletingStructure(structure)}
                    >
                      <Icons.Trash size={15} />
                      Delete
                    </MenuItem>
                  </Menu>
                </div>
              </SettingRow>
            ))}
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Callout tone="brand">
            Changing a rate prices the future only. Every invoice, credit note and GRV already
            issued keeps the percentage it was raised at, so a VAT change never rewrites a
            submitted return.
          </Callout>

          <VatCard
            title="Sales VAT"
            description="Charged to the customer. The default is applied to a new product unless you pick another."
            rates={salesRates}
            pending={pending}
            onAdd={() => setAddingVat('sales')}
            onEdit={setEditingVat}
            onDelete={setDeletingVat}
          />
          <VatCard
            title="Purchase VAT"
            description="Claimed back on what you buy. Often the same percentages as sales, but kept separate because they are not always."
            rates={purchaseRates}
            pending={pending}
            onAdd={() => setAddingVat('purchase')}
            onEdit={setEditingVat}
            onDelete={setDeletingVat}
          />
        </div>
      )}

      <RepriceModal
        open={repricing}
        onClose={() => setRepricing(false)}
        structures={structures}
        departments={departments}
        brands={brands}
        defaultEndingDirection={defaultEndingDirection}
        onDone={(result) => {
          if (result.ok) {
            toast.success(result.message)
            setRepricing(false)
            router.refresh()
          } else {
            toast.error(result.error)
          }
        }}
      />

      <StructureModal
        structure={addingStructure ? null : editingStructure}
        open={addingStructure || editingStructure !== null}
        pending={pending}
        onClose={() => {
          setAddingStructure(false)
          setEditingStructure(null)
        }}
        onSave={(input) =>
          run(() => savePriceStructureAction(editingStructure?.id ?? null, input))
        }
      />

      <VatModal
        rate={addingVat ? null : editingVat}
        vatType={addingVat ?? editingVat?.vatType ?? 'sales'}
        open={addingVat !== null || editingVat !== null}
        pending={pending}
        onClose={() => {
          setAddingVat(null)
          setEditingVat(null)
        }}
        onSave={(input) => run(() => saveVatRateAction(editingVat?.id ?? null, input))}
      />

      <ConfirmModal
        open={deletingStructure !== null}
        onClose={() => setDeletingStructure(null)}
        onConfirm={() =>
          deletingStructure && run(() => deletePriceStructureAction(deletingStructure.id))
        }
        title={`Delete ${deletingStructure?.name}?`}
        message="A price type that products are priced under cannot be deleted, because the prices would go with it. Turn it off instead — the prices are kept and come back if you turn it on again."
        confirmLabel="Delete price type"
        busy={pending}
      />

      <ConfirmModal
        open={deletingVat !== null}
        onClose={() => setDeletingVat(null)}
        onConfirm={() => deletingVat && run(() => deleteVatRateAction(deletingVat.id))}
        title={`Delete ${deletingVat?.name}?`}
        message="A rate still used by products cannot be deleted. Documents already issued are unaffected — they keep the percentage they were raised at."
        confirmLabel="Delete rate"
        busy={pending}
      />
    </>
  )
}

function VatCard({
  title,
  description,
  rates,
  pending,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string
  description: string
  rates: VatRateRow[]
  pending: boolean
  onAdd: () => void
  onEdit: (rate: VatRateRow) => void
  onDelete: (rate: VatRateRow) => void
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={
          <Button variant="secondary" onClick={onAdd} disabled={pending}>
            <Icons.Plus size={15} />
            Add rate
          </Button>
        }
      />
      <div>
        {rates.map((rate) => (
          <SettingRow
            key={rate.id}
            icon={<Icons.Percent size={16} />}
            label={`${rate.name} — ${formatRate(rate.rate)}`}
            description={describeVat(rate)}
          >
            <div className="flex items-center gap-1.5">
              {rate.isDefault && <Badge tone="brand">Default</Badge>}
              {!rate.isActive && <Badge tone="neutral">Off</Badge>}
              <Menu label="More" variant="ghost">
                <MenuItem onClick={() => onEdit(rate)}>
                  <Icons.Pencil size={15} />
                  Edit
                </MenuItem>
                <MenuItem tone="danger" disabled={pending} onClick={() => onDelete(rate)}>
                  <Icons.Trash size={15} />
                  Delete
                </MenuItem>
              </Menu>
            </div>
          </SettingRow>
        ))}
      </div>
    </Card>
  )
}

/** Trailing zeros off: 15.000 reads as 15%, but 12.500 must keep its half. */
function formatRate(rate: number): string {
  return `${Number(rate.toFixed(3))}%`
}

/** Space-grouped, matching formatMoney — a catalogue hits five digits fast. */
function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function describeStructure(structure: PriceStructureRow): string {
  const parts: string[] = []
  parts.push(
    structure.priceCount === 0
      ? 'no prices yet'
      : `${formatCount(structure.priceCount)} product price${structure.priceCount === 1 ? '' : 's'}`,
  )
  if (structure.groupCount > 0) {
    parts.push(
      `${formatCount(structure.groupCount)} customer group${structure.groupCount === 1 ? '' : 's'}`,
    )
  }
  if (structure.usedOnline) parts.push('sold online')
  return parts.join(' · ')
}

function describeVat(rate: VatRateRow): string {
  const parts: string[] = [rate.code]
  parts.push(
    rate.productCount === 0
      ? 'unused'
      : `${formatCount(rate.productCount)} product${rate.productCount === 1 ? '' : 's'}`,
  )
  return parts.join(' · ')
}

function StructureModal({
  structure,
  open,
  pending,
  onClose,
  onSave,
}: {
  structure: PriceStructureRow | null
  open: boolean
  pending: boolean
  onClose: () => void
  onSave: (input: PriceStructureInput) => void
}) {
  const [form, setForm] = useState<PriceStructureInput>(() => blankStructure())
  const [seeded, setSeeded] = useState<number | null>(null)

  // Seed from the row being edited the first time the modal opens for it.
  if (open && seeded !== (structure?.id ?? 0)) {
    setSeeded(structure?.id ?? 0)
    setForm(
      structure
        ? { name: structure.name, isDefault: structure.isDefault, isActive: structure.isActive }
        : blankStructure(),
    )
  }
  if (!open && seeded !== null) setSeeded(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={structure ? `Edit ${structure.name}` : 'Add a price type'}
      description="A tier of selling price — Retail, Wholesale, Staff. Each product can carry one price per type."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(form)} disabled={pending}>
            {pending ? 'Saving…' : structure ? 'Save changes' : 'Add price type'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" hint="What it is called on the product form and the customer group.">
          <Input
            value={form.name}
            onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
            placeholder="Wholesale"
            maxLength={60}
          />
        </Field>

        <Switch
          checked={!!form.isDefault}
          onChange={(v) => setForm((c) => ({ ...c, isDefault: v, isActive: v || c.isActive }))}
          label="Use as the default"
          hint="What the till charges a walk-in, and any customer whose group has no price type of its own."
        />

        <Switch
          checked={form.isActive !== false}
          onChange={(v) => setForm((c) => ({ ...c, isActive: v }))}
          disabled={!!form.isDefault}
          label="In use"
          hint="Turn off to hide it without losing the prices stored under it."
        />

        {structure && structure.priceCount > 0 && (
          <Callout tone="brand">
            {structure.priceCount} product price
            {structure.priceCount === 1 ? ' is' : 's are'} stored under this type. Renaming is safe;
            turning it off hides them until it is turned back on.
          </Callout>
        )}
      </div>
    </Modal>
  )
}

function VatModal({
  rate,
  vatType,
  open,
  pending,
  onClose,
  onSave,
}: {
  rate: VatRateRow | null
  vatType: VatType
  open: boolean
  pending: boolean
  onClose: () => void
  onSave: (input: VatRateInput) => void
}) {
  const [form, setForm] = useState<VatRateInput>(() => blankVat(vatType))
  const [seeded, setSeeded] = useState<number | null>(null)

  if (open && seeded !== (rate?.id ?? 0)) {
    setSeeded(rate?.id ?? 0)
    setForm(
      rate
        ? {
            vatType: rate.vatType,
            code: rate.code,
            name: rate.name,
            rate: rate.rate,
            isDefault: rate.isDefault,
            isActive: rate.isActive,
          }
        : blankVat(vatType),
    )
  }
  if (!open && seeded !== null) setSeeded(null)

  const set = <K extends keyof VatRateInput>(key: K, value: VatRateInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rate ? `Edit ${rate.name}` : 'Add a VAT rate'}
      description="Rates are kept separately for what you charge and what you are charged."
      /* A long dialog: the default 60vh cap letterboxed it with empty desktop
         above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(form)} disabled={pending}>
            {pending ? 'Saving…' : rate ? 'Save changes' : 'Add rate'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Applies to"
          hint={
            rate
              ? 'Fixed after creation — products select buying and selling rates from separate lists.'
              : 'Sales rates are charged to the customer; purchase rates are what you claim back.'
          }
        >
          <div className="w-56">
            <Select
              value={form.vatType}
              onChange={(e) => set('vatType', e.target.value as VatType)}
              disabled={rate !== null}
            >
              <option value="sales">Sales</option>
              <option value="purchase">Purchases</option>
            </Select>
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" hint="The short handle — STD, ZERO, EXEMPT.">
            <Input
              value={form.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              placeholder="STD"
              maxLength={16}
            />
          </Field>
          <Field label="Name" hint="What appears in the dropdown.">
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Standard rate"
              maxLength={60}
            />
          </Field>
        </div>

        <Field label="Percentage" hint="Enter 15 for 15%. Up to three decimals.">
          <div className="w-40">
            <NumberInput
              value={form.rate}
              onChange={(e) => set('rate', Number(String(e.target.value).replace(',', '.')) || 0)}
              step="0.001"
              min="0"
              max="100"
            />
          </div>
        </Field>

        <Switch
          checked={!!form.isDefault}
          onChange={(v) => setForm((c) => ({ ...c, isDefault: v, isActive: v || c.isActive }))}
          label="Use as the default"
          hint="Pre-selected on a new product."
        />

        <Switch
          checked={form.isActive !== false}
          onChange={(v) => setForm((c) => ({ ...c, isActive: v }))}
          disabled={!!form.isDefault}
          label="Available to select"
          hint="Turn off to retire a rate without touching the products that used it."
        />

        {rate && rate.productCount > 0 && (
          <Callout tone="warning">
            {rate.productCount} product{rate.productCount === 1 ? '' : 's'} use this rate. Changing
            the percentage changes what they charge from the next sale onward. Documents already
            issued keep the rate they were raised at.
          </Callout>
        )}
      </div>
    </Modal>
  )
}

function blankStructure(): PriceStructureInput {
  return { name: '', isDefault: false, isActive: true }
}

function blankVat(vatType: VatType): VatRateInput {
  return { vatType, code: '', name: '', rate: 0, isDefault: false, isActive: true }
}

'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Save, Plus, Trash, ChevronDown, ChevronRight } from '@/components/ui/icons'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Combobox,
  CurrencyInput,
  Field,
  Input,
  NumberInput,
  Switch,
  type ComboboxOption,
} from '@/components/ui'
import PicturePicker from '@/components/PicturePicker'
import { saveInstructionAction, type InstructionFormState } from './actions'
import type { InstructionGroup, InstructionOption } from '@/lib/site/instructions'
import type { StorefrontImage } from '@/lib/site/storefrontImages'

const FORM_ID = 'instruction-form'

/** A row in the editor. `key` is local only — React needs a stable identity for
 *  rows that have no database id yet. */
type Row = {
  key: string
  id?: number
  name: string
  priceAdjust: number
  productId: number | null
  quantity: number
  isDefault: boolean
  maxQty: number
  minQty: number
  defaultQty: number
  imageId: number | null
  image: StorefrontImage | null
  printsOnKitchen: boolean
  printsOnReceipt: boolean
  revealsGroupIds: number[]
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" form={FORM_ID} variant="primary" disabled={pending}>
      <Save size={15} />
      {pending ? 'Saving…' : 'Save instruction'}
    </Button>
  )
}

/**
 * Type-ahead picker for the optional stock link. This list is capped at 500
 * products — as a native <select> it was a dropdown nobody could scan; typing
 * a code or a few letters of the description is how anyone actually finds one.
 *
 * The chosen id travels in the hidden `optionProduct` input beside it, so the
 * save action's parallel-array contract is untouched.
 */
function ProductPicker({
  products,
  value,
  onChange,
}: {
  products: { id: number; code: string; description: string }[]
  value: number | null
  onChange: (next: number | null) => void
}) {
  const selected = value === null ? undefined : products.find((p) => p.id === value)
  const [query, setQuery] = useState(selected?.description ?? '')

  const q = query.trim().toLowerCase()
  // The full selected label matching itself is not a search — show the whole
  // list again so a click into the box offers the alternatives.
  const searching = q.length > 0 && query !== selected?.description
  const matches = (
    searching
      ? products.filter(
          (p) => p.description.toLowerCase().includes(q) || p.code.toLowerCase().includes(q),
        )
      : products
  ).slice(0, 50)

  const options: ComboboxOption<undefined>[] = [
    { value: '', label: 'Nothing — text only', hint: 'No stock is deducted' },
    ...matches.map((p) => ({ value: String(p.id), label: p.description, hint: p.code })),
  ]

  return (
    <Combobox
      options={options}
      query={query}
      onQueryChange={setQuery}
      onSelect={(option) => {
        if (option.value === '') {
          onChange(null)
          setQuery('')
        } else {
          onChange(Number(option.value))
          setQuery(option.label)
        }
      }}
      placeholder="Nothing — text only"
      className="w-full"
    />
  )
}

/** "up to 3", "2–4", "any number" — how many of ONE answer may be taken. */
function countRule(min: number, max: number): string | null {
  if (max === 1 && min <= 1) return null // the ordinary tick box; nothing to say
  if (max === 0) return min > 0 ? `at least ${min}` : 'any number'
  if (min > 0 && min !== max) return `${min}–${max}`
  if (min > 0 && min === max) return `exactly ${min}`
  return `up to ${max}`
}

export default function InstructionForm({
  group,
  options,
  products,
  groups,
  groupImage,
  rowActions,
}: {
  group: InstructionGroup | null
  options: InstructionOption[]
  /** For the optional "deducts stock" link on an option. */
  products: { id: number; code: string; description: string }[]
  /** Every other instruction, for the "then ask" picker. */
  groups: { id: number; name: string }[]
  /** The group's own picture, resolved server-side for the thumbnail. */
  groupImage: StorefrontImage | null
  rowActions?: React.ReactNode
}) {
  const [state, formAction] = useActionState<InstructionFormState, FormData>(
    saveInstructionAction,
    { error: null },
  )

  const [required, setRequired] = useState(group?.isRequired ?? false)
  const [active, setActive] = useState(group?.isActive ?? true)
  const [image, setImage] = useState<{ id: number | null; current: StorefrontImage | null }>({
    id: group?.imageId ?? null,
    current: groupImage,
  })

  // maxChoices drives whether the till shows radios or checkboxes, so it is
  // held in state to keep the explanatory line below it honest.
  const [maxChoices, setMaxChoices] = useState(group?.maxChoices ?? 1)

  const [rows, setRows] = useState<Row[]>(() =>
    options.length
      ? options.map((o) => ({
          key: `db-${o.id}`,
          id: o.id,
          name: o.name,
          priceAdjust: o.priceAdjust,
          productId: o.productId,
          quantity: o.quantity,
          isDefault: o.isDefault,
          maxQty: o.maxQty,
          minQty: o.minQty,
          defaultQty: o.defaultQty,
          imageId: o.imageId,
          // Resolved lazily by the picker itself; the server does not pre-load a
          // thumbnail per option, which would be one query per row.
          image: null,
          printsOnKitchen: o.printsOnKitchen,
          printsOnReceipt: o.printsOnReceipt,
          revealsGroupIds: o.revealsGroupIds,
        }))
      : // A new instruction starts with one blank row rather than an empty
        // table — there is no useful state in which a question has no answers.
        [blankRow(0)],
  )

  /**
   * Which rows are open.
   *
   * Everything past the name and the price is in a panel that stays shut, and
   * that is the point: an option is a name and sometimes a price, and putting
   * its thirteen settings on screen at once turns a two-minute job into a form
   * nobody wants to read. A new row opens itself, because a row you just added
   * is the one you are about to fill in.
   */
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const addRow = () =>
    setRows((prev) => {
      const row = blankRow(prev.length)
      setOpen((o) => new Set(o).add(row.key))
      return [...prev, row]
    })

  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  const setRow = <K extends keyof Row>(key: string, field: K, value: Row[K]) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)))

  /**
   * Ticking a default in a pick-one group unticks the others: the till can only
   * preselect one answer, and leaving two ticked would make the choice depend
   * on row order.
   */
  const setDefault = (key: string, next: boolean) =>
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, isDefault: next }
          : maxChoices === 1 && next
            ? { ...r, isDefault: false }
            : r,
      ),
    )

  const single = maxChoices === 1

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-4">
      <div className="flex items-center gap-2">
        <SubmitButton />
        {rowActions}
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-4">
        {group && <input type="hidden" name="id" value={group.id} />}

        {state.error && (
          <Callout tone="danger" title="Could not save">
            {state.error}
          </Callout>
        )}

        <Card>
          <CardHeader
            title="The question"
            description="What the cashier is asked when this product is sold."
          />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" hint="How you refer to it here, e.g. “Choice of bread”.">
              <Input name="name" defaultValue={group?.name ?? ''} maxLength={120} required />
            </Field>

            <Field
              label="Prompt"
              hint="Shown to the cashier. Falls back to the name when left blank."
            >
              <Input
                name="prompt"
                defaultValue={group?.prompt ?? ''}
                maxLength={190}
                placeholder="e.g. How would you like your eggs?"
              />
            </Field>

            <Field
              label="Maximum choices"
              hint={
                single
                  ? 'One answer — the till shows radio buttons.'
                  : maxChoices === 0
                    ? 'Any number of answers — the till shows checkboxes.'
                    : `Up to ${maxChoices} answers — the till shows checkboxes.`
              }
            >
              <NumberInput
                name="maxChoices"
                precision={0}
                value={maxChoices}
                onChange={(e) => setMaxChoices(Number(e.target.value) || 0)}
                className="text-right"
              />
            </Field>

            <Field
              label="Minimum choices"
              hint="0 lets the cashier skip. Cannot be above the maximum."
            >
              <NumberInput
                name="minChoices"
                precision={0}
                defaultValue={group?.minChoices ?? 0}
                className="text-right"
              />
            </Field>

            <Field
              label="Picture"
              hint="Optional. Shown above the question on a touchscreen till."
            >
              <input type="hidden" name="imageId" value={image.id ?? ''} />
              <PicturePicker
                value={image.id}
                current={image.current}
                onChange={(next) => setImage({ id: next?.id ?? null, current: next })}
              />
            </Field>

            <div className="flex flex-col gap-3 sm:col-span-2">
              <input type="hidden" name="isRequired" value={required ? '1' : '0'} />
              <Switch
                checked={required}
                onChange={setRequired}
                label="Required"
                hint="The cashier must answer before the line can be completed."
              />

              <input type="hidden" name="isActive" value={active ? '1' : '0'} />
              <Switch
                checked={active}
                onChange={setActive}
                label="Active"
                hint="Switch off to stop the till asking this, without detaching it from products."
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Answers"
            description="The options the cashier can choose from. Open one to set how many may be taken, a picture, and where it prints."
            action={
              <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                <Plus size={14} />
                Add option
              </Button>
            }
          />
          <CardBody className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <OptionRow
                key={row.key}
                row={row}
                index={i}
                open={open.has(row.key)}
                onToggle={() => toggle(row.key)}
                products={products}
                groups={groups.filter((g) => g.id !== group?.id)}
                onChange={setRow}
                onDefault={setDefault}
                onRemove={() => removeRow(row.key)}
                canRemove={rows.length > 1}
              />
            ))}

            <p className="mt-1 text-xs text-muted">
              Blank rows are ignored. “Deducts stock” is optional — link it to a product when
              choosing the option should consume stock, such as an extra portion of bacon.
            </p>
          </CardBody>
        </Card>
      </form>
    </div>
  )
}

function blankRow(index: number): Row {
  return {
    key: `new-${index}-${index}`,
    name: '',
    priceAdjust: 0,
    productId: null,
    quantity: 1,
    isDefault: false,
    maxQty: 1,
    minQty: 0,
    defaultQty: 0,
    imageId: null,
    image: null,
    printsOnKitchen: true,
    printsOnReceipt: true,
    revealsGroupIds: [],
  }
}

/**
 * One answer: a summary line that is always visible, and a panel that is not.
 *
 * Every field still submits whether the panel is open or shut — they are inputs
 * in the form either way, only hidden. Rendering them conditionally would mean a
 * closed row silently saving its defaults over whatever was configured.
 */
function OptionRow({
  row,
  index,
  open,
  onToggle,
  products,
  groups,
  onChange,
  onDefault,
  onRemove,
  canRemove,
}: {
  row: Row
  index: number
  open: boolean
  onToggle: () => void
  products: { id: number; code: string; description: string }[]
  groups: { id: number; name: string }[]
  onChange: <K extends keyof Row>(key: string, field: K, value: Row[K]) => void
  onDefault: (key: string, next: boolean) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const rule = countRule(row.minQty, row.maxQty)
  const reveals = groups.filter((g) => row.revealsGroupIds.includes(g.id))

  return (
    <div className="rounded-card border border-border">
      {/* Carries the id so an edited row keeps its identity rather than being
          deleted and recreated. Outside the flex row below: a hidden input is
          still a flex child and would be laid out as an empty gap. */}
      <input type="hidden" name="optionId" value={row.id ?? ''} />

      {/* ── The summary line ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={open ? 'Hide the details' : 'Show the details'}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </Button>

        {/* The wrapper takes the flex sizing, not the input: every control in
            the kit is `w-full`, which fights `flex-1` applied to it directly. */}
        <div className="min-w-0 flex-1">
          <Input
            name="optionName"
            value={row.name}
            onChange={(e) => onChange(row.key, 'name', e.target.value)}
            maxLength={120}
            placeholder="e.g. Brown bread"
          />
        </div>

        <div className="w-28 shrink-0">
          <CurrencyInput
            name="optionPrice"
            value={row.priceAdjust}
            onChange={(e) => onChange(row.key, 'priceAdjust', Number(e.target.value) || 0)}
            className="text-right"
            aria-label={`Price adjustment for ${row.name || 'this option'}`}
          />
        </div>

        {/* Value is the row index so an unticked box sends nothing and cannot
            be read as its neighbour. */}
        <label className="flex shrink-0 items-center gap-2 px-2 text-sm text-ink-2">
          <Checkbox
            name="optionDefault"
            value={String(index)}
            checked={row.isDefault}
            onChange={(e) => onDefault(row.key, e.target.checked)}
          />
          Preselected
        </label>

        <Button
          type="button"
          variant="danger-ghost"
          size="sm"
          iconOnly
          aria-label={`Remove ${row.name || 'option'}`}
          onClick={onRemove}
          disabled={!canRemove}
        >
          <Trash size={14} />
        </Button>
      </div>

      {/* What the shut panel is hiding, so it can be seen at a glance. */}
      {!open && (rule || row.productId !== null || reveals.length > 0 || row.imageId !== null) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          {rule && <Badge>{rule}</Badge>}
          {row.imageId !== null && <Badge>Picture</Badge>}
          {row.productId !== null && (
            <Badge tone="brand">
              Deducts {products.find((p) => p.id === row.productId)?.description ?? 'stock'}
            </Badge>
          )}
          {reveals.map((g) => (
            <Badge key={g.id} tone="brand">
              Then asks {g.name}
            </Badge>
          ))}
          {!row.printsOnKitchen && <Badge tone="warning">Not on kitchen ticket</Badge>}
          {!row.printsOnReceipt && <Badge tone="warning">Not on receipt</Badge>}
        </div>
      )}

      {/* ── The panel ───────────────────────────────────────────────────── */}
      <div
        className={`grid gap-5 border-t border-border p-4 sm:grid-cols-2 ${open ? '' : 'hidden'}`}
      >
        <Field
          label="Most you can take"
          hint={
            row.maxQty === 1
              ? 'One — a plain tick box.'
              : row.maxQty === 0
                ? 'Any number — the till shows a stepper.'
                : `Up to ${row.maxQty} — the till shows a stepper.`
          }
        >
          <NumberInput
            name="optionMaxQty"
            precision={0}
            value={row.maxQty}
            onChange={(e) => onChange(row.key, 'maxQty', Number(e.target.value) || 0)}
            className="text-right"
          />
        </Field>

        <Field
          label="Least you can take"
          hint="Applies once this answer is chosen. It does not make it compulsory — that is the question's own “required”."
        >
          <NumberInput
            name="optionMinQty"
            precision={0}
            value={row.minQty}
            onChange={(e) => onChange(row.key, 'minQty', Number(e.target.value) || 0)}
            className="text-right"
          />
        </Field>

        <Field
          label="Preselected number"
          hint="How many are already chosen when the till shows the question. Only used when “Preselected” is ticked."
        >
          <NumberInput
            name="optionDefaultQty"
            precision={0}
            value={row.defaultQty}
            onChange={(e) => onChange(row.key, 'defaultQty', Number(e.target.value) || 0)}
            className="text-right"
            disabled={!row.isDefault}
          />
        </Field>

        <Field label="Picture" hint="Optional. Shown on the answer at a touchscreen till.">
          <input type="hidden" name="optionImage" value={row.imageId ?? ''} />
          <PicturePicker
            value={row.imageId}
            current={row.image}
            onChange={(next) => {
              onChange(row.key, 'imageId', next?.id ?? null)
              onChange(row.key, 'image', next)
            }}
          />
        </Field>

        <Field label="Deducts stock" hint="Leave empty when the answer is only words on a ticket.">
          {/* The picked id submits from here; the Combobox is only how it gets
              chosen. */}
          <input type="hidden" name="optionProduct" value={row.productId ?? ''} />
          <ProductPicker
            products={products}
            value={row.productId}
            onChange={(next) => onChange(row.key, 'productId', next)}
          />
        </Field>

        <Field
          label="Quantity taken"
          hint="How much of that product ONE of this answer uses up."
        >
          <NumberInput
            name="optionQuantity"
            precision={3}
            value={row.quantity}
            onChange={(e) => onChange(row.key, 'quantity', Number(e.target.value) || 0)}
            disabled={row.productId === null}
            className="text-right"
          />
        </Field>

        <div className="flex flex-col gap-3 sm:col-span-2">
          {/* Explicit 1/0 rather than a checkbox value: an unticked box sends
              nothing, which the server cannot tell apart from a field that never
              arrived — and the safe reading of "missing" is "keep printing". */}
          <input type="hidden" name="optionKitchen" value={row.printsOnKitchen ? '1' : '0'} />
          <Switch
            checked={row.printsOnKitchen}
            onChange={(next) => onChange(row.key, 'printsOnKitchen', next)}
            label="Print on the kitchen ticket"
            hint="Switch off for an answer the cook does not need, such as a choice of side plate."
          />

          <input type="hidden" name="optionReceipt" value={row.printsOnReceipt ? '1' : '0'} />
          <Switch
            checked={row.printsOnReceipt}
            onChange={(next) => onChange(row.key, 'printsOnReceipt', next)}
            label="Print on the customer's receipt"
            hint="Switch off to keep a free answer such as “no onions” off the slip."
          />
        </div>

        {groups.length > 0 && (
          <Field
            label="Then ask"
            hint="Choosing this answer goes on to ask these questions too — “make it a meal” asking which side and which drink."
            className="sm:col-span-2"
          >
            <input
              type="hidden"
              name="optionReveals"
              value={row.revealsGroupIds.join(',')}
            />
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm text-ink-2">
                  <Checkbox
                    checked={row.revealsGroupIds.includes(g.id)}
                    onChange={(e) =>
                      onChange(
                        row.key,
                        'revealsGroupIds',
                        e.target.checked
                          ? [...row.revealsGroupIds, g.id]
                          : row.revealsGroupIds.filter((id) => id !== g.id),
                      )
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>

    </div>
  )
}

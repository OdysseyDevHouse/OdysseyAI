'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { StatusError, Save, Plus, Trash } from '@/components/ui/icons'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  CurrencyInput,
  Field,
  Input,
  NumberInput,
  Select,
  Switch,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
import { saveInstructionAction, type InstructionFormState } from './actions'
import type { InstructionGroup, InstructionOption } from '@/lib/site/instructions'

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
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" form={FORM_ID} disabled={pending}>
      <Save size={15} />
      {pending ? 'Saving…' : 'Save instruction'}
    </Button>
  )
}

export default function InstructionForm({
  group,
  options,
  products,
  rowActions,
}: {
  group: InstructionGroup | null
  options: InstructionOption[]
  /** For the optional "deducts stock" link on an option. */
  products: { id: number; code: string; description: string }[]
  rowActions?: React.ReactNode
}) {
  const [state, formAction] = useActionState<InstructionFormState, FormData>(
    saveInstructionAction,
    { error: null },
  )

  const [required, setRequired] = useState(group?.isRequired ?? false)
  const [active, setActive] = useState(group?.isActive ?? true)

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
        }))
      : // A new instruction starts with one blank row rather than an empty
        // table — there is no useful state in which a question has no answers.
        [{ key: 'new-0', name: '', priceAdjust: 0, productId: null, quantity: 1, isDefault: false }],
  )

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      {
        key: `new-${prev.length}-${prev.length ? prev[prev.length - 1].key : '0'}`,
        name: '',
        priceAdjust: 0,
        productId: null,
        quantity: 1,
        isDefault: false,
      },
    ])

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
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <StatusError size={15} />
            {state.error}
          </p>
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
            description="The options the cashier can choose from. A price adjustment is added to the line; leave it at zero when the choice costs nothing."
            action={
              <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                <Plus size={14} />
                Add option
              </Button>
            }
          />
          <CardBody>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Option</th>
                    <th className={`${TABLE_TH} text-right`}>Price adj.</th>
                    <th className={TABLE_TH}>Deducts stock</th>
                    <th className={`${TABLE_TH} text-right`}>Qty</th>
                    <th className={TABLE_TH}>{single ? 'Preselected' : 'Preselected'}</th>
                    <th className={TABLE_TH} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.key} className="border-b border-border last:border-b-0">
                      <td className={TABLE_TD}>
                        {/* Carries the id so an edited row keeps its identity
                            rather than being deleted and recreated. */}
                        <input type="hidden" name="optionId" value={row.id ?? ''} />
                        <Input
                          name="optionName"
                          value={row.name}
                          onChange={(e) => setRow(row.key, 'name', e.target.value)}
                          maxLength={120}
                          placeholder="e.g. Brown bread"
                        />
                      </td>

                      <td className={TABLE_TD}>
                        <CurrencyInput
                          name="optionPrice"
                          value={row.priceAdjust}
                          onChange={(e) => setRow(row.key, 'priceAdjust', Number(e.target.value) || 0)}
                          className="w-28 text-right"
                        />
                      </td>

                      <td className={TABLE_TD}>
                        <Select
                          name="optionProduct"
                          value={row.productId ?? ''}
                          onChange={(e) =>
                            setRow(row.key, 'productId', e.target.value ? Number(e.target.value) : null)
                          }
                          className="w-56"
                        >
                          <option value="">Nothing — text only</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.code} · {p.description}
                            </option>
                          ))}
                        </Select>
                      </td>

                      <td className={TABLE_TD}>
                        <NumberInput
                          name="optionQuantity"
                          precision={3}
                          value={row.quantity}
                          onChange={(e) => setRow(row.key, 'quantity', Number(e.target.value) || 0)}
                          disabled={row.productId === null}
                          className="w-24 text-right"
                        />
                      </td>

                      <td className={TABLE_TD}>
                        {/* Value is the row index so an unticked box sends
                            nothing and cannot be read as its neighbour. */}
                        <Checkbox
                          name="optionDefault"
                          value={String(i)}
                          checked={row.isDefault}
                          onChange={(e) => setDefault(row.key, e.target.checked)}
                        />
                      </td>

                      <td className={`${TABLE_TD} text-right`}>
                        <Button
                          type="button"
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove ${row.name || 'option'}`}
                          onClick={() => removeRow(row.key)}
                          disabled={rows.length === 1}
                        >
                          <Trash size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-muted">
              Blank rows are ignored. “Deducts stock” is optional — link it to a product when
              choosing the option should consume stock, such as an extra portion of bacon.
            </p>
          </CardBody>
        </Card>
      </form>
    </div>
  )
}

'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
  PageHeader,
  PickerResults,
  Select,
  SettingRow,
  Switch,
  Textarea,
  useToast,
  TABLE_HEAD_ROW,
  TABLE_TD,
  TABLE_TH,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  CONTRACT_FREQUENCIES,
  CONTRACT_FREQUENCY_LABELS,
  MONTH_NAMES,
  annualValue,
  contractTotal,
  escalatedPrice,
  nextBillingDate,
  refuseContract,
  type ContractFrequency,
  type ContractLineInput,
} from '@/lib/contractModel'
import { saveContractAction } from './actions'

/**
 * Creating and editing a contract.
 *
 * ── WHY THE PREVIEW IS THE POINT ─────────────────────────────────────────
 *
 * A contract is a promise about money that will move automatically, every month,
 * for years, with nobody watching. The single most valuable thing this screen
 * can do is show — before it is saved — exactly what it will bill and when, and
 * what the escalation does to that figure over the next few years.
 *
 * The preview is computed with the SAME pure functions the nightly tick uses
 * (contractModel.ts), so what the screen promises and what the biller does
 * cannot drift apart.
 */

export type CustomerOption = {
  id: number
  code: string
  name: string
  email: string | null
  status: string
}

export type ProductOption = {
  id: number
  code: string
  description: string
  sellingIncl: number
  departmentId: number | null
}

export type ContractFormValues = {
  id?: number
  name: string
  customerId: number
  frequency: ContractFrequency
  billingDay: number
  startsOn: string
  endsOn: string
  escalationPct: number
  escalationMonth: number | null
  autoSend: boolean
  offerPaymentLink: boolean
  paymentTermsDays: number
  reference: string
  notes: string
  internalNote: string
  lines: ContractLineInput[]
}

export function ContractForm({
  initial,
  customers,
  products,
  defaultVatRate,
  canAutoSend,
  paymentsConfigured,
  emailConfigured,
}: {
  initial: ContractFormValues
  customers: CustomerOption[]
  products: ProductOption[]
  defaultVatRate: number
  /** Whether this user may switch on automatic sending at all. */
  canAutoSend: boolean
  /** Whether a payment gateway exists, so the pay-link switch means anything. */
  paymentsConfigured: boolean
  /** Whether SMTP is set up, so an emailed invoice can actually leave. */
  emailConfigured: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [values, setValues] = useState<ContractFormValues>(initial)
  const [error, setError] = useState<string | null>(null)
  const [productSearch, setProductSearch] = useState('')

  const isEdit = !!initial.id

  function set<K extends keyof ContractFormValues>(key: K, value: ContractFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  function setLine(index: number, patch: Partial<ContractLineInput>) {
    setValues((v) => ({
      ...v,
      lines: v.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }))
  }

  function addProduct(product: ProductOption) {
    setValues((v) => ({
      ...v,
      lines: [
        ...v.lines,
        {
          productId: product.id,
          productCode: product.code,
          description: product.description,
          qty: 1,
          // The product's current price, copied ONCE. From here it is the
          // contracted price and never re-read — see contracts.ts.
          unitPriceIncl: product.sellingIncl,
          vatRatePct: defaultVatRate,
          departmentId: product.departmentId,
        },
      ],
    }))
    setProductSearch('')
  }

  function addFreeText() {
    setValues((v) => ({
      ...v,
      lines: [
        ...v.lines,
        {
          productId: null,
          productCode: null,
          description: '',
          qty: 1,
          unitPriceIncl: 0,
          vatRatePct: defaultVatRate,
          departmentId: null,
        },
      ],
    }))
  }

  function removeLine(index: number) {
    setValues((v) => ({ ...v, lines: v.lines.filter((_, i) => i !== index) }))
  }

  const total = contractTotal(values.lines)
  const perYear = annualValue(total, values.frequency)

  const matches = useMemo(() => {
    const term = productSearch.trim().toLowerCase()
    if (!term) return []
    return products
      .filter(
        (p) =>
          p.description.toLowerCase().includes(term) || p.code.toLowerCase().includes(term),
      )
      .slice(0, 8)
  }, [productSearch, products])

  // The next few billing dates and what each will cost, from the same functions
  // the tick uses. This is the screen's whole argument for existing.
  const preview = useMemo(() => {
    if (!values.startsOn || values.lines.length === 0) return []
    const out: { date: string; amount: number }[] = []
    let cursor: string | null = null

    for (let i = 0; i < 4; i++) {
      const next: string | null = nextBillingDate(
        {
          frequency: values.frequency,
          billingDay: values.billingDay,
          startsOn: values.startsOn,
          endsOn: values.endsOn || null,
          lastGeneratedFor: cursor,
        },
        // Look forward from the start, not from today: a contract starting next
        // year should still preview its first four invoices.
        values.startsOn,
      )
      if (!next) break

      // How many escalations will have landed by that date.
      const raises =
        values.escalationPct > 0 && values.escalationMonth
          ? countRaises(values.startsOn, next, values.escalationMonth)
          : 0

      out.push({ date: next, amount: escalatedPrice(total, values.escalationPct, raises) })
      cursor = next
    }
    return out
  }, [
    values.startsOn,
    values.endsOn,
    values.frequency,
    values.billingDay,
    values.escalationPct,
    values.escalationMonth,
    values.lines.length,
    total,
  ])

  function submit() {
    const input = {
      name: values.name,
      customerId: values.customerId,
      frequency: values.frequency,
      billingDay: values.billingDay,
      startsOn: values.startsOn,
      endsOn: values.endsOn || null,
      escalationPct: values.escalationPct,
      escalationMonth: values.escalationMonth,
      autoSend: values.autoSend,
      offerPaymentLink: values.offerPaymentLink,
      paymentTermsDays: values.paymentTermsDays,
      reference: values.reference || null,
      notes: values.notes || null,
      internalNote: values.internalNote || null,
      lines: values.lines,
    }

    // The same refusal the server would give, shown before the round trip.
    const invalid = refuseContract(input)
    if (invalid) {
      setError(invalid)
      return
    }
    setError(null)

    startTransition(async () => {
      const result = await saveContractAction(input, values.id)
      if (result.ok) {
        toast.success(result.message)
        router.push(result.id ? `/sales/contracts/${result.id}` : '/sales/contracts')
        router.refresh()
      } else {
        setError(result.error)
        toast.error(result.error)
      }
    })
  }

  const customer = customers.find((c) => c.id === values.customerId)

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit contract' : 'New contract'}
        subtitle={
          isEdit
            ? values.name
            : 'Bill a customer the same products every month, automatically'
        }
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => router.back()} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create contract'}
            </Button>
          </div>
        }
      />

      <PageBody>
        {error ? <Callout tone="danger">{error}</Callout> : null}

        {/* ── Who and what ────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="The agreement"
            description="Who is billed, and what this contract is called on their invoice."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Contract name" hint="Appears on the contract list and in reports.">
              <Input
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Monitoring — Northcliff branch"
              />
            </Field>

            <Field
              label="Customer"
              hint={
                customer && !customer.email
                  ? 'This account has no email address, so invoices cannot be sent to it.'
                  : undefined
              }
            >
              <Select
                value={String(values.customerId || '')}
                onChange={(e) => set('customerId', Number(e.target.value))}
              >
                <option value="">Choose a customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Their reference" hint="Optional. A PO or contract number of theirs.">
              <Input
                value={values.reference}
                onChange={(e) => set('reference', e.target.value)}
                placeholder="PO-2027-0088"
              />
            </Field>

            <Field label="Payment terms" hint="Days from invoice date to due date.">
              <NumberInput
                value={values.paymentTermsDays}
                onChange={(e) => set('paymentTermsDays', Number(e.target.value) || 0)}
                min={0}
                max={365}
                className="max-w-32"
              />
            </Field>
          </CardBody>
        </Card>

        {/* ── What gets billed ────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="What is billed"
            description="Prices are copied from the product once, then belong to this contract — a price change in the catalogue will not re-price a signed agreement."
            action={
              <Button variant="ghost" size="sm" onClick={addFreeText}>
                <Icons.Plus size={14} />
                Free-text line
              </Button>
            }
          />
          <CardBody>
            <Field label="Add a product">
              <Input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search by code or description…"
                icon={<Icons.Search size={15} />}
              />
            </Field>

            <PickerResults
              results={matches.map((p) => ({
                key: p.id,
                label: p.description,
                meta: p.code,
                trailing: formatMoney(p.sellingIncl),
              }))}
              onPick={(key) => {
                const product = products.find((p) => p.id === Number(key))
                if (product) addProduct(product)
              }}
            />

            {productSearch.trim() && matches.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Nothing matches “{productSearch.trim()}”. Add a free-text line for a
                service that is not in the catalogue.
              </p>
            ) : null}

            {values.lines.length === 0 ? (
              <p className="mt-4 rounded-control border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                Nothing on this contract yet. Search for a product above, or add a
                free-text line for a service that is not in the catalogue.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Description</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Qty</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Unit price</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>VAT %</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                      <th className={TABLE_TH} />
                    </tr>
                  </thead>
                  <tbody>
                    {values.lines.map((line, index) => (
                      <tr key={index} className="border-b border-border last:border-0">
                        <td className={TABLE_TD}>
                          <Input
                            value={line.description}
                            onChange={(e) => setLine(index, { description: e.target.value })}
                            placeholder="What is being billed"
                          />
                          {line.productCode ? (
                            <span className="mt-1 block text-xs text-muted">
                              {line.productCode}
                            </span>
                          ) : null}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          <NumberInput
                            value={line.qty}
                            onChange={(e) => setLine(index, { qty: Number(e.target.value) || 0 })}
                            min={0}
                            step={1}
                            className="w-20"
                          />
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          <CurrencyInput
                            value={line.unitPriceIncl}
                            onChange={(e) => setLine(index, { unitPriceIncl: Number(e.target.value) || 0 })}
                            className="w-32"
                          />
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          <NumberInput
                            value={line.vatRatePct}
                            onChange={(e) => setLine(index, { vatRatePct: Number(e.target.value) || 0 })}
                            min={0}
                            max={100}
                            className="w-20"
                          />
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric text-ink`}>
                          {formatMoney(line.qty * line.unitPriceIncl)}
                        </td>
                        <td className={TABLE_TD}>
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Remove ${line.description || 'line'}`}
                            onClick={() => removeLine(index)}
                          >
                            <Icons.Trash size={14} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {values.lines.length > 0 ? (
              <div className="mt-4 flex items-baseline justify-end gap-6 border-t border-border pt-4">
                <span className="text-sm text-muted">Per invoice</span>
                <span className="numeric text-xl font-semibold text-ink">
                  {formatMoney(total)}
                </span>
              </div>
            ) : null}
          </CardBody>
        </Card>

        {/* ── When ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="When it bills"
            description="A missed run catches up — three missed months bill as three invoices, each at the price that was right for that month."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="How often">
              <Select
                value={values.frequency}
                onChange={(e) => set('frequency', e.target.value as ContractFrequency)}
              >
                {CONTRACT_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {CONTRACT_FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Billing day"
              hint="A 31 falls back to the last day in short months."
            >
              <NumberInput
                value={values.billingDay}
                onChange={(e) => set('billingDay', Number(e.target.value) || 1)}
                min={1}
                max={31}
              />
            </Field>

            <Field label="Starts on">
              <Input
                type="date"
                value={values.startsOn}
                onChange={(e) => set('startsOn', e.target.value)}
              />
            </Field>

            <Field label="Ends on" hint="Leave blank to run until cancelled.">
              <Input
                type="date"
                value={values.endsOn}
                onChange={(e) => set('endsOn', e.target.value)}
              />
            </Field>
          </CardBody>
        </Card>

        {/* ── Escalation ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Annual escalation"
            description="The increase happens in a month you nominate, so a whole book of contracts rises together. It compounds — each year's rise is on last year's price."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Increase" hint="Leave at 0 for a contract whose price never moves.">
              <div className="flex items-center gap-2">
                <NumberInput
                  value={values.escalationPct}
                  onChange={(e) => set('escalationPct', Number(e.target.value) || 0)}
                  min={0}
                  max={100}
                  step={0.5}
                  className="max-w-28"
                />
                <span className="text-sm text-muted">% a year</span>
              </div>
            </Field>

            <Field
              label="Increase month"
              hint={
                values.escalationPct > 0
                  ? 'The first increase is the first of these months after the contract starts.'
                  : undefined
              }
            >
              <Select
                value={values.escalationMonth ? String(values.escalationMonth) : ''}
                onChange={(e) =>
                  set('escalationMonth', e.target.value ? Number(e.target.value) : null)
                }
                disabled={values.escalationPct === 0}
              >
                <option value="">No increase</option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
        </Card>

        {/* ── Sending ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Sending"
            description="What happens on the billing day, without anybody pressing a button."
          />
          <CardBody className="space-y-4">
            {!emailConfigured ? (
              <Callout tone="warning">
                Email is not set up on this system, so invoices cannot be sent. The
                contract will still raise them for someone to send by hand.
              </Callout>
            ) : null}

            {/* Switches rather than checkboxes: both of these change what the
                system does unattended, which is a setting rather than a field
                on a form. SettingRow gives each one room to say so. */}
            <div className="-mx-6 border-y border-border">
              <SettingRow
                icon={<Icons.Send size={16} />}
                label="Bill and send automatically"
                description={
                  canAutoSend
                    ? 'The invoice posts to the customer’s account and is emailed with nobody reviewing it. Best switched on after you have watched this contract produce one correct invoice.'
                    : 'You do not have permission to turn this on.'
                }
              >
                <Switch
                  checked={values.autoSend}
                  onChange={(checked) => set('autoSend', checked)}
                  disabled={!canAutoSend}
                  aria-label="Bill and send automatically"
                />
              </SettingRow>

              <SettingRow
                icon={<Icons.CreditCard size={16} />}
                label="Include a “pay online” link"
                description={
                  paymentsConfigured
                    ? 'Adds a payment link to the emailed invoice and its PDF.'
                    : 'No payment gateway is set up, so no link can be offered.'
                }
              >
                <Switch
                  checked={values.offerPaymentLink}
                  onChange={(checked) => set('offerPaymentLink', checked)}
                  disabled={!paymentsConfigured}
                  aria-label="Include a pay online link"
                />
              </SettingRow>
            </div>

            <Field label="Note on the invoice" hint="Optional. Prints on every invoice this contract raises.">
              <Textarea
                value={values.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={2}
                placeholder="Monitoring services for the month."
              />
            </Field>

            <Field label="Internal note" hint="Optional. Never printed or emailed.">
              <Textarea
                value={values.internalNote}
                onChange={(e) => set('internalNote', e.target.value)}
                rows={2}
              />
            </Field>
          </CardBody>
        </Card>

        {/* ── The preview ─────────────────────────────────────────────── */}
        {preview.length > 0 ? (
          <Card>
            <CardHeader
              title="What this will bill"
              description={`${formatMoney(perYear)} a year at today's price.`}
            />
            <CardBody>
              <ul className="space-y-2">
                {preview.map((p, i) => (
                  <li
                    key={p.date}
                    className="flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0"
                  >
                    <span className="text-sm text-ink-2">
                      {p.date}
                      {i === 0 ? (
                        <span className="ml-2 text-xs text-muted">first invoice</span>
                      ) : null}
                    </span>
                    <span
                      className={`numeric text-sm ${
                        i > 0 && p.amount !== preview[i - 1]!.amount
                          ? 'font-semibold text-warning'
                          : 'text-ink'
                      }`}
                    >
                      {formatMoney(p.amount)}
                    </span>
                  </li>
                ))}
              </ul>
              {values.escalationPct > 0 && values.escalationMonth ? (
                <p className="mt-3 text-xs text-muted">
                  Amounts in amber are the first invoice after an increase.
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
      </PageBody>
    </>
  )
}

/**
 * How many annual increases will have landed by a date.
 *
 * A local copy of the tick's rule — the first increase is the first escalation
 * month STRICTLY AFTER the start date, then annually — so the preview and the
 * biller agree about which invoice carries the first rise.
 */
function countRaises(startsOn: string, by: string, month: number): number {
  const start = new Date(`${startsOn}T00:00:00`)
  const until = new Date(`${by}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(until.getTime())) return 0

  let year = start.getFullYear()
  if (month - 1 <= start.getMonth()) year++

  let count = 0
  for (let guard = 0; guard < 50; guard++) {
    const candidate = new Date(year, month - 1, 1)
    if (candidate > until) break
    count++
    year++
  }
  return count
}

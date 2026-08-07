'use client'

import { useActionState, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CurrencyInput,
  Field,
  Icons,
  Input,
  NumberInput,
  SectionTitle,
  Select,
  Textarea,
} from '@/components/ui'
import type { Supplier, SupplierStatus } from '@/lib/site/suppliers'
import { saveSupplierAction, type SupplierFormState } from './actions'

const FORM_ID = 'supplier-form'

function SubmitButton({ isNew }: { isNew: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" form={FORM_ID} variant="primary" disabled={pending}>
      <Icons.Save size={15} />
      {pending ? 'Saving…' : isNew ? 'Create supplier' : 'Save changes'}
    </Button>
  )
}

export default function SupplierForm({
  supplier,
  categories,
  rowActions,
}: {
  supplier: Supplier | null
  categories: string[]
  rowActions?: ReactNode
}) {
  const [state, formAction] = useActionState<SupplierFormState, FormData>(saveSupplierAction, {
    error: null,
  })
  const [status, setStatus] = useState<SupplierStatus>(supplier?.status ?? 'active')

  // Mirrored here so the preview updates as the terms are typed. The server
  // owns the real calculation (annualisedDiscountRate in interestRules.ts,
  // which is server-only); this is presentation of the same formula.
  const [discountPct, setDiscountPct] = useState(supplier?.settlementDiscountPct ?? 0)
  const [discountDays, setDiscountDays] = useState(supplier?.settlementDiscountDays ?? 0)
  const [termsDays, setTermsDays] = useState(supplier?.paymentTermsDays ?? 30)

  // Discount earned on the NET amount paid, hence pct/(100-pct), scaled by how
  // much earlier the money leaves. 365-day year, matching interestRules.ts.
  const daysEarly = termsDays - discountDays
  const annualised =
    discountPct > 0 && discountPct < 100 && daysEarly > 0
      ? (discountPct / (100 - discountPct)) * (365 / daysEarly) * 100
      : 0

  const isNew = supplier === null

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-6 pt-4">
        {rowActions}
        <SubmitButton isNew={isNew} />
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-5 px-6 pt-4 pb-10">
        {supplier && <input type="hidden" name="id" value={supplier.id} />}

        {state.error && <Callout tone="danger" title={state.error} />}

        <Card>
          <SectionTitle icon={<Icons.Truck size={16} />}>Account</SectionTitle>
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Code" hint="Unique. Appears on orders and remittances.">
                <Input name="code" defaultValue={supplier?.code ?? ''} required maxLength={32} />
              </Field>
              <Field label="Name">
                <Input name="name" defaultValue={supplier?.name ?? ''} required maxLength={160} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Status">
                <Select
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as SupplierStatus)}
                >
                  <option value="active">Active</option>
                  <option value="on_hold">On hold</option>
                  <option value="inactive">Inactive</option>
                  <option value="closed">Closed</option>
                </Select>
              </Field>
              {status !== 'active' && (
                <Field label="Reason" hint="Shown beside the status badge.">
                  <Input
                    name="statusReason"
                    defaultValue={supplier?.statusReason ?? ''}
                    maxLength={190}
                    placeholder="e.g. Quality dispute"
                  />
                </Field>
              )}
              <Field label="Our account number" hint="The reference they know us by.">
                <Input
                  name="accountNumber"
                  defaultValue={supplier?.accountNumber ?? ''}
                  maxLength={60}
                />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <SectionTitle icon={<Icons.Clock size={16} />}>Trading terms</SectionTitle>
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="Payment terms (days)" hint="Drives the payables age analysis.">
                <NumberInput
                  name="paymentTermsDays"
                  defaultValue={supplier?.paymentTermsDays ?? 30}
                  onChange={(e) => setTermsDays(Number(e.target.value) || 0)}
                />
              </Field>
              <Field label="Lead time (days)" hint="Order to delivery.">
                <NumberInput name="leadTimeDays" defaultValue={supplier?.leadTimeDays ?? 0} />
              </Field>
              <Field label="Minimum order">
                <CurrencyInput name="minimumOrder" defaultValue={supplier?.minimumOrder ?? 0} />
              </Field>
              {supplier && (
                <Field
                  label="Balance"
                  hint="What we owe them. Moves only through posted transactions."
                >
                  <CurrencyInput value={supplier.balance} readOnly disabled />
                </Field>
              )}
            </div>

            {/* Settlement discount. Kept in its own group because it is a
                different question from "when is this due" — it is "what do we
                save by paying sooner", and the payment run screen ranks
                suppliers by it. */}
            <div className="border-t border-border pt-4">
              <div className="grid gap-4 sm:grid-cols-4">
                <Field
                  label="Settlement discount (%)"
                  hint="What they take off for early payment."
                >
                  <NumberInput
                    name="settlementDiscountPct"
                    step="0.01"
                    defaultValue={supplier?.settlementDiscountPct ?? 0}
                    onChange={(e) => setDiscountPct(Number(e.target.value) || 0)}
                  />
                </Field>
                <Field label="…if paid within (days)" hint="Counted from the invoice date.">
                  <NumberInput
                    name="settlementDiscountDays"
                    defaultValue={supplier?.settlementDiscountDays ?? 0}
                    onChange={(e) => setDiscountDays(Number(e.target.value) || 0)}
                  />
                </Field>
              </div>

              {/* The two numbers are easy to enter the wrong way round, and the
                  annualised figure is the one that says whether taking it is
                  actually worth the cash. Both are shown as you type. */}
              {discountPct > 0 && discountDays > 0 && (
                <p className="mt-3 text-sm text-muted">
                  <span className="text-ink">
                    {discountPct}/{discountDays} net {termsDays}
                  </span>{' '}
                  — pay within {discountDays} days and take {discountPct}% off.
                  {annualised > 0 && (
                    <>
                      {' '}
                      That is worth about{' '}
                      <span className={annualised >= 15 ? 'text-success' : 'text-ink'}>
                        {annualised.toFixed(0)}% a year
                      </span>{' '}
                      {annualised >= 15
                        ? '— well above most overdraft rates, so it is usually worth taking.'
                        : '— compare that against what your overdraft costs before paying early.'}
                    </>
                  )}
                </p>
              )}
            </div>

            <Field label="Category" hint="Free text — how you group your suppliers.">
              <Input
                name="category"
                defaultValue={supplier?.category ?? ''}
                list="supplier-categories"
                maxLength={60}
                className="sm:max-w-xs"
              />
              <datalist id="supplier-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </CardBody>
        </Card>

        <Card>
          <SectionTitle icon={<Icons.Mail size={16} />}>Contact</SectionTitle>
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Contact name">
                <Input name="contactName" defaultValue={supplier?.contactName ?? ''} maxLength={120} />
              </Field>
              <Field label="Email" hint="Where orders and remittances are sent.">
                <Input name="email" type="email" defaultValue={supplier?.email ?? ''} maxLength={190} />
              </Field>
              <Field label="Phone">
                <Input name="phone" defaultValue={supplier?.phone ?? ''} maxLength={40} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address line 1">
                <Input name="addressLine1" defaultValue={supplier?.addressLine1 ?? ''} maxLength={190} />
              </Field>
              <Field label="Address line 2">
                <Input name="addressLine2" defaultValue={supplier?.addressLine2 ?? ''} maxLength={190} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="City">
                <Input name="city" defaultValue={supplier?.city ?? ''} maxLength={120} />
              </Field>
              <Field label="Postal code">
                <Input name="postalCode" defaultValue={supplier?.postalCode ?? ''} maxLength={20} />
              </Field>
              <Field label="VAT number">
                <Input name="vatNumber" defaultValue={supplier?.vatNumber ?? ''} maxLength={40} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <SectionTitle icon={<Icons.Banknote size={16} />}>Banking</SectionTitle>
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Bank">
                <Input name="bankName" defaultValue={supplier?.bankName ?? ''} maxLength={120} />
              </Field>
              <Field label="Branch code">
                <Input name="bankBranch" defaultValue={supplier?.bankBranch ?? ''} maxLength={60} />
              </Field>
              <Field label="Account number">
                <Input name="bankAccount" defaultValue={supplier?.bankAccount ?? ''} maxLength={60} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <SectionTitle icon={<Icons.FileText size={16} />}>Notes</SectionTitle>
          <CardBody>
            <Textarea
              name="notes"
              defaultValue={supplier?.notes ?? ''}
              rows={4}
              aria-label="Notes"
            />
          </CardBody>
        </Card>
      </form>
    </>
  )
}

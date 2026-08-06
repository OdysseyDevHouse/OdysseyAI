'use client'

import { useActionState, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Button,
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

  const isNew = supplier === null

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-6 pt-4">
        {rowActions}
        <SubmitButton isNew={isNew} />
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-5 px-6 pt-4 pb-10">
        {supplier && <input type="hidden" name="id" value={supplier.id} />}

        {state.error && (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <Icons.StatusError size={15} />
            {state.error}
          </p>
        )}

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
          <CardBody>
            <Field label="Notes">
              <Textarea name="notes" defaultValue={supplier?.notes ?? ''} rows={4} />
            </Field>
          </CardBody>
        </Card>
      </form>
    </>
  )
}

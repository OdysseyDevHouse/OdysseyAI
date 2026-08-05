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
import {
  ACCOUNT_TYPE_OPTIONS,
  DEFAULT_ACCOUNT_TYPE,
  accountTypeOption,
  toAccountType,
} from '@/lib/accountTypes'
import type { Customer, CustomerStatus } from '@/lib/site/customers'
import type { CustomerGroup, SalesRep } from '@/lib/site/customerLookups'
import { saveCustomerAction, type CustomerFormState } from './actions'

/** Shared by Save in the header and the form itself, so one button can sit outside. */
const FORM_ID = 'customer-form'

function SubmitButton({ isNew }: { isNew: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" form={FORM_ID} variant="primary" disabled={pending}>
      <Icons.Save size={15} />
      {pending ? 'Saving…' : isNew ? 'Create customer' : 'Save changes'}
    </Button>
  )
}

export default function CustomerForm({
  customer,
  groups,
  reps,
  categories,
  rowActions,
}: {
  customer: Customer | null
  groups: CustomerGroup[]
  reps: SalesRep[]
  categories: string[]
  /** Delete lives in its own <form>, so it is rendered outside this one. */
  rowActions?: ReactNode
}) {
  const [state, formAction] = useActionState<CustomerFormState, FormData>(saveCustomerAction, {
    error: null,
  })

  // Only genuinely interactive state is controlled; everything else is an
  // uncontrolled input with a defaultValue, read from FormData on submit.
  const [status, setStatus] = useState<CustomerStatus>(customer?.status ?? 'active')
  const [accountType, setAccountType] = useState(customer?.accountType ?? DEFAULT_ACCOUNT_TYPE)
  const [groupId, setGroupId] = useState(String(customer?.groupId ?? ''))

  const group = groups.find((g) => g.id === Number(groupId))
  const isNew = customer === null

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-6 pt-4">
        {rowActions}
        <SubmitButton isNew={isNew} />
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-5 px-6 pt-4 pb-10">
        {customer && <input type="hidden" name="id" value={customer.id} />}

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
          <CardBody className="flex flex-col gap-4">
            <SectionTitle icon={<Icons.Contact size={15} />}>Account</SectionTitle>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Code" hint="Unique. Appears on statements and invoices.">
                <Input name="code" defaultValue={customer?.code ?? ''} required maxLength={32} />
              </Field>
              <Field label="Name">
                <Input name="name" defaultValue={customer?.name ?? ''} required maxLength={160} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Status">
                <Select
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as CustomerStatus)}
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
                    defaultValue={customer?.statusReason ?? ''}
                    maxLength={190}
                    placeholder="e.g. Payment overdue 60 days"
                  />
                </Field>
              )}
            </div>

            <Field
              label="Account type"
              hint="Decides whether this customer may buy on account, and who allocates their payments."
            >
              <Select
                name="accountType"
                value={accountType}
                onChange={(e) => setAccountType(toAccountType(e.target.value))}
              >
                {ACCOUNT_TYPE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            {/* The chosen type's own description, rather than a hint that has to
                describe all four at once. Selecting is the moment someone wants
                to know what they just picked. */}
            <p className="text-sm text-muted">{accountTypeOption(accountType).description}</p>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-4">
            <SectionTitle icon={<Icons.Users size={15} />}>Classification</SectionTitle>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Group"
                hint={
                  isNew && group
                    ? `Defaults: ${group.defaultTermsDays} days, limit ${group.defaultCreditLimit.toFixed(2)}`
                    : undefined
                }
              >
                <Select name="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">— No group —</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sales rep">
                <Select name="repId" defaultValue={String(customer?.repId ?? '')}>
                  <option value="">— No rep —</option>
                  {reps.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category" hint="Free text — region, industry, whatever you sort by.">
                <Input
                  name="category"
                  defaultValue={customer?.category ?? ''}
                  list="customer-categories"
                  maxLength={60}
                />
                <datalist id="customer-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-4">
            <SectionTitle icon={<Icons.Coins size={15} />}>Credit terms</SectionTitle>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Payment terms (days)" hint="Zero means cash on delivery.">
                <NumberInput
                  name="paymentTermsDays"
                  defaultValue={customer?.paymentTermsDays ?? group?.defaultTermsDays ?? 30}
                />
              </Field>
              <Field label="Credit limit" hint="Zero means no credit granted — not unlimited.">
                <CurrencyInput
                  name="creditLimit"
                  defaultValue={customer?.creditLimit ?? group?.defaultCreditLimit ?? 0}
                />
              </Field>
              {customer && (
                <Field
                  label="Balance"
                  hint="Moves only through posted transactions — it cannot be edited here."
                >
                  <CurrencyInput value={customer.balance} readOnly disabled />
                </Field>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-4">
            <SectionTitle icon={<Icons.Mail size={15} />}>Contact</SectionTitle>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Contact name">
                <Input name="contactName" defaultValue={customer?.contactName ?? ''} maxLength={120} />
              </Field>
              <Field label="Email" hint="Where statements are sent.">
                <Input name="email" type="email" defaultValue={customer?.email ?? ''} maxLength={190} />
              </Field>
              <Field label="Phone">
                <Input name="phone" defaultValue={customer?.phone ?? ''} maxLength={40} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address line 1">
                <Input name="addressLine1" defaultValue={customer?.addressLine1 ?? ''} maxLength={190} />
              </Field>
              <Field label="Address line 2">
                <Input name="addressLine2" defaultValue={customer?.addressLine2 ?? ''} maxLength={190} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="City">
                <Input name="city" defaultValue={customer?.city ?? ''} maxLength={120} />
              </Field>
              <Field label="Postal code">
                <Input name="postalCode" defaultValue={customer?.postalCode ?? ''} maxLength={20} />
              </Field>
              <Field label="VAT number" hint="Required on a tax invoice.">
                <Input name="vatNumber" defaultValue={customer?.vatNumber ?? ''} maxLength={40} />
              </Field>
              <Field label="Loyalty number">
                <Input name="loyaltyNumber" defaultValue={customer?.loyaltyNumber ?? ''} maxLength={60} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Field label="Notes">
              <Textarea name="notes" defaultValue={customer?.notes ?? ''} rows={4} />
            </Field>
          </CardBody>
        </Card>
      </form>
    </>
  )
}

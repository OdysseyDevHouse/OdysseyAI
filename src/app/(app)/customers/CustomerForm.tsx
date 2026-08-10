'use client'

import { useActionState, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
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
  Select,
  Checkbox,
  Textarea,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  ACCOUNT_TYPE_OPTIONS,
  DEFAULT_ACCOUNT_TYPE,
  accountTypeOption,
  toAccountType,
} from '@/lib/accountTypes'
import {
  periodContaining,
  toStatementCycle,
  CYCLE_LABELS,
  STATEMENT_CYCLES,
  type StatementCycle,
} from '@/lib/statementCycles'
import type { Customer, CustomerStatus } from '@/lib/site/customers'
import type { CustomerGroup, SalesRep } from '@/lib/site/customerLookups'
import { saveCustomerAction, type CustomerFormState } from './actions'

/** Shared by Save in the header and the form itself, so one button can sit outside. */
const FORM_ID = 'customer-form'

/**
 * How often the account is statemented, and on what rhythm.
 *
 * Which anchor field is shown depends on the cycle, because the two mean
 * different things: monthly wants a day of the month, weekly wants a date that
 * sets the phase. Held in state rather than rendered both-and-disabled so only
 * the meaningful one is ever posted.
 *
 * The preview underneath is the reason statementCycles.ts is a pure module —
 * it runs here in the browser, so an anchor can be checked before saving
 * instead of after.
 */
function StatementCycleFields({
  customer,
  group,
}: {
  customer: Customer | null
  group: CustomerGroup | undefined
}) {
  const [cycle, setCycle] = useState<StatementCycle>(
    customer?.statementCycle ?? group?.defaultStatementCycle ?? 'monthly',
  )
  const [anchorDay, setAnchorDay] = useState(
    String(customer?.statementAnchorDay ?? group?.defaultStatementAnchorDay ?? 0),
  )
  const [anchorDate, setAnchorDate] = useState(customer?.statementAnchorDate ?? '')

  const preview = periodContaining(
    {
      cycle,
      anchorDay: Number(anchorDay) || 0,
      anchorDate: anchorDate || null,
      fallbackAnchor: customer ? isoDate(customer.createdAt) : undefined,
    },
    isoDate(new Date()),
  )

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Statement cycle" hint="How often this account is statemented.">
          <Select
            name="statementCycle"
            value={cycle}
            onChange={(e) => setCycle(toStatementCycle(e.target.value))}
          >
            {STATEMENT_CYCLES.map((c) => (
              <option key={c} value={c}>
                {CYCLE_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

        {cycle === 'monthly' ? (
          <Field
            label="Cut on day"
            className="max-w-40"
            hint="Zero for calendar months. The 31st becomes the last day in shorter months."
          >
            <NumberInput
              name="statementAnchorDay"
              min={0}
              max={31}
              value={anchorDay}
              onChange={(e) => setAnchorDay(e.target.value)}
            />
          </Field>
        ) : (
          <Field
            label="Cycle starts"
            hint="Any day a period begins on — it sets the rhythm. Blank uses the creation date."
          >
            <Input
              name="statementAnchorDate"
              type="date"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
            />
          </Field>
        )}

        <div>
          <div className="mb-1.5 text-sm font-medium text-ink-2">Current period</div>
          <div className="flex h-control items-center font-medium text-ink">{preview.label}</div>
          <p className="mt-1.5 text-xs text-muted">
            {preview.from} to {preview.to}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted">
        Payment terms decide when an invoice is <strong className="text-ink-2">due</strong>. The
        cycle decides when the account is <strong className="text-ink-2">statemented</strong>. They
        are independent — an account on 30-day terms can still be statemented weekly.
      </p>
    </>
  )
}

/** A Date to yyyy-mm-dd in local time. */
function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

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
  suggestedCode = null,
  rowActions,
}: {
  customer: Customer | null
  groups: CustomerGroup[]
  reps: SalesRep[]
  categories: string[]
  /**
   * Pre-filled code for a new customer, or null when auto-numbering is off.
   * A suggestion only — the user may type over it, and the real code is
   * claimed on save. See lib/site/masterCodes.ts.
   */
  suggestedCode?: string | null
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
      {/* Gutters come from the page's <PageBody>, not from here. */}
      <div className="flex items-center justify-end gap-2">
        {rowActions}
        <SubmitButton isNew={isNew} />
      </div>

      <form id={FORM_ID} action={formAction} className="flex flex-col gap-5">
        {customer && <input type="hidden" name="id" value={customer.id} />}

        {state.error && (
          <Callout tone="danger" title="Could not save">
            {state.error}
          </Callout>
        )}

        <Card>
          <CardHeader title="Account" />
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Code"
                hint={
                  isNew && suggestedCode
                    ? 'Filled in for you. Type over it to use your own.'
                    : 'Unique. Appears on statements and invoices.'
                }
              >
                {/* Not `required` once a code is suggested: clearing the field
                    is how a user asks for the next one, and the server fills it
                    in. Still required when auto-numbering is off, because then
                    a blank code has nothing to become. */}
                <Input
                  name="code"
                  defaultValue={customer?.code ?? suggestedCode ?? ''}
                  required={!(isNew && suggestedCode)}
                  maxLength={32}
                />
              </Field>
              <Field label="Name">
                <Input name="name" defaultValue={customer?.name ?? ''} required maxLength={160} />
              </Field>
            </div>

            {/* Status and account type sit on one row; Reason takes the third
                column only when the status calls for one, so the two selects
                stay put either way rather than reflowing as it appears. */}
            <div className="grid gap-4 sm:grid-cols-3">
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

            {/* The chosen type's own description, rather than a hint that has to
                describe all four at once. Selecting is the moment someone wants
                to know what they just picked. */}
            <p className="text-sm text-muted">{accountTypeOption(accountType).description}</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Classification" />
          <CardBody className="flex flex-col gap-4">
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
          <CardHeader title="Credit terms" />
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Short numeric fields stay short — a full-width input for a
                  3-digit value tells the user the wrong thing. */}
              <Field label="Payment terms (days)" hint="Zero means cash on delivery." className="max-w-40">
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
                /* A figure, not a disabled input: nothing here is editable, so
                   nothing should look like a control that refuses to work. */
                <div>
                  <div className="mb-1.5 text-sm font-medium text-ink-2">Balance</div>
                  <div className="numeric flex h-control items-center text-lg font-semibold text-ink">
                    {formatMoney(customer.balance)}
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    Moves only through posted transactions — it cannot be edited here.
                  </p>
                </div>
              )}
            </div>

            {/* Interest is a separate decision from credit, and a legal one:
                the National Credit Act requires it to be agreed in writing, so
                it is off until someone deliberately turns it on. */}
            <div className="border-t border-border pt-4">
              {/* A Checkbox rather than a Switch: this form posts via FormData
                  and Switch is controlled, so it would submit nothing. */}
              <Checkbox
                name="interestEnabled"
                defaultChecked={customer?.interestEnabled ?? false}
                label="Charge interest on overdue amounts"
              />
              <p className="mt-1 text-sm text-muted">
                Only switch this on where the customer has agreed to it in writing — the National
                Credit Act requires that.
              </p>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field
                  label="Interest rate (% a year)"
                  className="max-w-40"
                  hint={
                    group?.defaultInterestRatePct
                      ? `Leave at zero to use the group's ${group.defaultInterestRatePct}%.`
                      : 'Annual nominal rate, as the agreement states it.'
                  }
                >
                  <NumberInput
                    name="interestRatePct"
                    step="0.01"
                    defaultValue={customer?.interestRatePct ?? 0}
                  />
                </Field>
                <Field
                  label="Grace period (days)"
                  className="max-w-40"
                  hint="Days past due before interest starts to accrue."
                >
                  <NumberInput
                    name="interestGraceDays"
                    defaultValue={customer?.interestGraceDays ?? 0}
                  />
                </Field>
              </div>
            </div>

            {/* Cycle is not terms. Terms decide when an invoice falls DUE; the
                cycle decides when the account is CUT into a statement. They are
                independent, and saying so here is cheaper than the support call. */}
            <div className="border-t border-border pt-4">
              <StatementCycleFields customer={customer} group={group} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Contact" />
          <CardBody className="flex flex-col gap-4">
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
          <CardHeader title="Notes" />
          <CardBody>
            <Textarea name="notes" defaultValue={customer?.notes ?? ''} rows={4} aria-label="Notes" />
          </CardBody>
        </Card>
      </form>
    </>
  )
}

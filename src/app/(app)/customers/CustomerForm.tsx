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

function SubmitButton({ isNew, confirming }: { isNew: boolean; confirming: boolean }) {
  const { pending } = useFormStatus()
  // The label changes while a duplicate warning stands, so the button says what
  // pressing it now means. "Create customer" twice in a row reads as though the
  // first press failed.
  const label = confirming
    ? isNew
      ? 'Create anyway'
      : 'Save anyway'
    : isNew
      ? 'Create customer'
      : 'Save changes'
  return (
    <Button type="submit" form={FORM_ID} variant="primary" disabled={pending}>
      <Icons.Save size={15} />
      {pending ? 'Saving…' : label}
    </Button>
  )
}

export default function CustomerForm({
  customer,
  groups,
  reps,
  categories,
  structures = [],
  suggestedCode = null,
  rowActions,
}: {
  customer: Customer | null
  groups: CustomerGroup[]
  reps: SalesRep[]
  categories: string[]
  /** Price structures for the pricing override. Empty hides the card. */
  structures?: { id: number; name: string }[]
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

  /*
   * REMOUNT KEY FOR THE FIELDS A GROUP SEEDS.
   *
   * Those fields are uncontrolled — `defaultValue` plus FormData on submit,
   * per the note above — and React applies a defaultValue ONLY when the node
   * first mounts. Changing the group re-renders with a new default that an
   * already-mounted input ignores, so picking a group after touching the box
   * left the old figure sitting there. Worse, it was inconsistent: an
   * untouched CurrencyInput happened to pick the change up, a typed-in one
   * did not, which is exactly the sort of "sometimes works" that reads as a
   * saving bug rather than a form one.
   *
   * Keying on the group id makes the remount real, so every seeded field
   * re-reads its default the moment the group changes.
   *
   * Only on a NEW account: an existing one must never have its agreed terms
   * silently rewritten by someone reassigning its group, which is the whole
   * point of these being a starting point rather than a live lookup. So the
   * key is constant once `customer` exists, and nothing remounts.
   */
  const seedKey = isNew ? `group-${groupId || 'none'}` : 'existing'

  /*
   * PUTTING BACK WHAT WAS TYPED, AFTER A DUPLICATE WARNING.
   *
   * The warning returns to this same mounted form instead of redirecting, and
   * by the note above an uncontrolled input ignores a changed defaultValue —
   * so every field snapped back to its page-load value and the second press
   * posted an empty form. Measured over CDP: `code= name= ack=1`.
   *
   * `values` carries the submission back. `typed()` is what the fields read, so
   * a field with a returned value shows it and every other field keeps the
   * default it always had. Appending the warning to the remount key is what
   * makes the already-mounted inputs actually pick them up — the same trick,
   * for the same reason, as the group seeding above.
   */
  const returned = state.values ?? null
  const typed = (name: string, fallback: string): string => returned?.[name] ?? fallback

  return (
    <>
      {/* Gutters come from the page's <PageBody>, not from here. */}
      <div className="flex items-center justify-end gap-2">
        {rowActions}
        <SubmitButton isNew={isNew} confirming={Boolean(state.duplicateWarning)} />
      </div>

      {/*
        Keyed on whether a warning stands, so the whole form REMOUNTS when one
        arrives. Without it the defaultValues above are ignored — React applies
        a defaultValue only on first mount (see the seedKey note), so the
        returned values would be computed correctly and never reach the DOM.
        One flip, on a form the user is already looking at, and only ever
        between "clean" and "warned".
      */}
      <form
        key={state.duplicateWarning ? 'warned' : 'clean'}
        id={FORM_ID}
        action={formAction}
        className="flex flex-col gap-5"
      >
        {customer && <input type="hidden" name="id" value={customer.id} />}

        {state.error && (
          <Callout tone="danger" title="Could not save">
            {state.error}
          </Callout>
        )}

        {/*
          A pause, not a refusal — hence 'warning' rather than 'danger', and
          "might" rather than "is". The hidden field below carries the
          acknowledgement back on the next submit, so pressing Save a second
          time goes through. Rendered only while the warning stands, so a form
          that has never seen one submits without it.
        */}
        {state.duplicateWarning && (
          <>
            <Callout tone="warning" title="This customer may already exist">
              {state.duplicateWarning}
            </Callout>
            <input type="hidden" name="confirmedDuplicate" value="1" />
          </>
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
                  defaultValue={typed('code', customer?.code ?? suggestedCode ?? '')}
                  required={!(isNew && suggestedCode)}
                  maxLength={32}
                />
              </Field>
              <Field label="Name">
                <Input
                  name="name"
                  defaultValue={typed('name', customer?.name ?? '')}
                  required
                  maxLength={160}
                />
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
                  key={seedKey}
                  name="paymentTermsDays"
                  defaultValue={customer?.paymentTermsDays ?? group?.defaultTermsDays ?? 30}
                />
              </Field>
              <Field label="Credit limit" hint="Zero means no credit granted — not unlimited.">
                <CurrencyInput
                  key={seedKey}
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

            {/* Spend limits cap VELOCITY where the credit limit caps EXPOSURE.
                Kept visually apart from the limit above, and labelled with the
                zero rule spelled out, because the two zeroes mean opposite
                things — a grant of nothing allows nothing, a restriction of
                nothing stops nothing. */}
            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-medium text-ink">Spend limits</h3>
              <p className="mt-1 text-sm text-muted">
                How much may go on the account in one day or one month. Unlike the credit limit,
                paying does not free these up — they cap how fast the account is drawn, not how
                much is owed. Leave at zero for no limit.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                {/* Seeded from the group on a NEW account only, like the credit
                    limit above — an existing account keeps what it agreed to. */}
                <Field label="Daily limit" hint="Zero means no daily limit.">
                  <CurrencyInput
                    key={seedKey}
                    name="dailyLimit"
                    defaultValue={customer?.dailyLimit ?? group?.defaultDailyLimit ?? 0}
                  />
                </Field>
                <Field label="Monthly limit" hint="Zero means no monthly limit.">
                  <CurrencyInput
                    key={seedKey}
                    name="monthlyLimit"
                    defaultValue={customer?.monthlyLimit ?? group?.defaultMonthlyLimit ?? 0}
                  />
                </Field>
              </div>
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
              {/* Same remount key as the credit fields: this component seeds its
                  own useState from the group, and useState reads its initial
                  value once for exactly the same reason defaultValue does. */}
              <StatementCycleFields key={seedKey} customer={customer} group={group} />
            </div>
          </CardBody>
        </Card>

        {structures.length > 0 && (
          <Card>
            <CardHeader
              title="Pricing"
              description="What this account pays. Terms of trade, so it sits with the credit terms."
            />
            <CardBody>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Price structure"
                  hint={
                    group?.priceStructureId
                      ? 'Leave on the default to follow the group.'
                      : 'Leave on the default to follow the site.'
                  }
                >
                  <Select name="priceStructureId" defaultValue={String(customer?.priceStructureId ?? '')}>
                    <option value="">
                      {group?.priceStructureId ? 'Group / site default' : 'Site default'}
                    </option>
                    {structures.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* Left BLANK rather than seeded, because this one resolves
                    live: an empty field means "follow the group", so prefilling
                    it with the group's number would silently pin the account to
                    today's value and stop it following a later change. */}
                <Field
                  label="Standing discount (%)"
                  className="max-w-40"
                  hint={
                    group?.defaultDiscountPct
                      ? `Leave blank to follow the group's ${group.defaultDiscountPct}%.`
                      : 'The default line discount wherever this account is attached — capped per product at its own ceiling.'
                  }
                >
                  <NumberInput
                    name="discountPct"
                    step="0.1"
                    defaultValue={customer?.discountPct ?? ''}
                  />
                </Field>
              </div>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Contact" />
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Contact name">
                <Input
                  name="contactName"
                  defaultValue={typed('contactName', customer?.contactName ?? '')}
                  maxLength={120}
                />
              </Field>
              {/* Email and phone carry typed() for a reason beyond tidiness:
                  they are the two fields a duplicate warning is ABOUT, so
                  losing them would make the warning unactionable — the person
                  could not see, or correct, the number it objected to. */}
              <Field label="Email" hint="Where statements are sent.">
                <Input
                  name="email"
                  type="email"
                  defaultValue={typed('email', customer?.email ?? '')}
                  maxLength={190}
                />
              </Field>
              <Field label="Phone">
                <Input
                  name="phone"
                  defaultValue={typed('phone', customer?.phone ?? '')}
                  maxLength={40}
                />
              </Field>
            </div>

            {/* Sits with the email rather than under Credit terms: it is a
                statement about where post goes, and the address it depends on
                is the field directly above it. */}
            <div className="border-t border-border pt-4">
              <Checkbox
                name="autoEmailInvoices"
                defaultChecked={customer?.autoEmailInvoices ?? false}
                label="Email every invoice to this account automatically"
              />
              <p className="mt-1 text-sm text-muted">
                Sent to the account email above as each invoice is finalised, with the PDF
                attached. Credit notes are not sent automatically.
              </p>
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

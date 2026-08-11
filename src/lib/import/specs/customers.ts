import 'server-only'
import {
  createCustomer, updateCustomer, getCustomer,
  type CustomerInput, type Customer,
} from '@/lib/site/customers'
import { loadLookups } from '../lookups'
import { mergeForUpdate } from '../merge'
import { text, number, boolean, choice, reference, date } from '../fields'
import type {
  ApplyContext, ExistingMode, ImportSpec, RowOutcome,
} from '../spec'

/**
 * Importing customers.
 *
 * ── THE PRICE LIST TRAP ──────────────────────────────────────────────────
 *
 * A file that says a customer buys at Wholesale is naming their GROUP, not a
 * price structure: `customers` has no price_structure_id, `customer_groups`
 * does. So the Price list column resolves against groups, and a shop whose
 * groups are not set up first will be told that rather than quietly getting
 * retail prices on every account — which is the sort of thing nobody notices
 * until a month of invoices has gone out at the wrong price.
 *
 * Opening balances are NOT imported here. What a customer owes arrives per
 * invoice through `/setup/opening-balances`, dated as it really was, because
 * that is what makes the first age analysis truthful. A Balance column on a
 * customer file would post one undated lump and quietly age every account as
 * current.
 */

export type CustomerDraft = Partial<CustomerInput>

const STATUSES = {
  Active: 'active',
  'On hold': 'on_hold',
  Inactive: 'inactive',
  Closed: 'closed',
} as const

const ACCOUNT_TYPES = {
  Cash: 'cash',
  Account: 'account',
} as const

const CYCLES = {
  Monthly: 'monthly',
  Weekly: 'weekly',
  Fortnightly: 'fortnightly',
} as const

export const customerSpec: ImportSpec<CustomerDraft> = {
  entity: 'customers',
  title: 'Customers',
  singular: 'customer',
  description: 'Who you sell to. What they owe is carried in separately, per invoice.',
  capability: 'customers.edit',
  matchKey: 'code',

  fields: [
    text<CustomerDraft>({
      key: 'code',
      label: 'Code',
      aliases: ['Code', 'Customer Code', 'Account Code', 'Acc Code'],
      hint: 'Leave the column out entirely to have codes generated.',
      example: 'CUST001',
      max: 32,
    }),
    text<CustomerDraft>({
      key: 'name',
      label: 'Name',
      aliases: ['Name', 'Customer Name', 'Customer', 'Company'],
      required: true,
      example: 'Smith, T (Pty) Ltd',
      max: 160,
    }),
    choice<CustomerDraft>({
      key: 'status',
      label: 'Status',
      aliases: ['Status'],
      options: STATUSES,
      hint: 'Anything other than Active needs a Status Reason.',
      example: 'Active',
    }),
    text<CustomerDraft>({
      key: 'statusReason',
      label: 'Status reason',
      aliases: ['Status Reason', 'Reason'],
      max: 190,
    }),
    choice<CustomerDraft>({
      key: 'accountType',
      label: 'Account type',
      aliases: ['Account Type', 'Type'],
      options: ACCOUNT_TYPES,
      example: 'Account',
    }),
    text<CustomerDraft>({
      key: 'contactName',
      label: 'Contact',
      aliases: ['Contact', 'Contact Name', 'Contact Person'],
      example: 'Thandi Smith',
      max: 120,
    }),
    text<CustomerDraft>({
      key: 'email',
      label: 'Email',
      aliases: ['Email', 'Email Address', 'E-mail'],
      hint: 'Where statements go.',
      example: 'accounts@smith.co.za',
      max: 190,
      blankClears: true,
    }),
    text<CustomerDraft>({
      key: 'phone',
      label: 'Phone',
      aliases: ['Phone', 'Telephone', 'Tel', 'Cell', 'Mobile'],
      example: '082 555 0100',
      max: 40,
      blankClears: true,
    }),
    text<CustomerDraft>({
      key: 'addressLine1',
      label: 'Address line 1',
      aliases: ['Address', 'Address Line 1', 'Address1', 'Street'],
      example: '12 Loop Street',
      max: 190,
    }),
    text<CustomerDraft>({
      key: 'addressLine2',
      label: 'Address line 2',
      aliases: ['Address Line 2', 'Address2', 'Suburb'],
      max: 190,
    }),
    text<CustomerDraft>({
      key: 'city',
      label: 'City',
      aliases: ['City', 'Town'],
      example: 'Cape Town',
      max: 120,
    }),
    text<CustomerDraft>({
      key: 'postalCode',
      label: 'Postal code',
      aliases: ['Postal Code', 'Post Code', 'Zip', 'Postcode'],
      example: '8001',
      max: 20,
    }),
    text<CustomerDraft>({
      key: 'vatNumber',
      label: 'VAT number',
      aliases: ['VAT Number', 'VAT No', 'VAT Reg', 'Tax Number'],
      example: '4123456789',
      max: 40,
    }),
    text<CustomerDraft>({
      key: 'loyaltyNumber',
      label: 'Loyalty number',
      aliases: ['Loyalty Number', 'Loyalty', 'Card Number'],
      max: 60,
    }),
    reference<CustomerDraft>({
      key: 'groupId',
      label: 'Group',
      aliases: ['Group', 'Customer Group', 'Price List', 'Price Structure'],
      lookup: 'customerGroup',
      table: (lookups) => lookups.customerGroupByName,
      noun: 'customer group',
      // Named explicitly because 'Price list' is the column heading most
      // exports use, and the group is where the price structure actually sits.
      fix: 'A price list is set on the group, not the account — add the group under Setup first.',
      hint: 'Which group this account belongs to. The group decides the price list.',
      example: 'Wholesale',
    }),
    reference<CustomerDraft>({
      key: 'repId',
      label: 'Sales rep',
      aliases: ['Rep', 'Sales Rep', 'Salesperson', 'Agent'],
      lookup: 'salesRep',
      table: (lookups) => lookups.salesRepByName,
      noun: 'sales rep',
      fix: 'Add them under Setup first.',
      example: 'Jane Dlamini',
    }),
    text<CustomerDraft>({
      key: 'category',
      label: 'Category',
      aliases: ['Category', 'Customer Category'],
      example: 'Retail',
      max: 60,
    }),
    number<CustomerDraft>({
      key: 'paymentTermsDays',
      label: 'Payment terms (days)',
      aliases: ['Payment Terms', 'Terms', 'Terms Days', 'Payment Days'],
      min: 0,
      max: 365,
      integer: true,
      example: '30',
    }),
    number<CustomerDraft>({
      key: 'creditLimit',
      label: 'Credit limit',
      aliases: ['Credit Limit', 'Limit'],
      hint: 'Zero means no credit is granted, not unlimited.',
      min: 0,
      example: '10000',
    }),
    boolean<CustomerDraft>({
      key: 'interestEnabled',
      label: 'Charge interest',
      aliases: ['Charge Interest', 'Interest', 'Interest Enabled'],
      hint: 'An explicit opt-in, separate from the rate.',
      example: 'No',
    }),
    number<CustomerDraft>({
      key: 'interestRatePct',
      label: 'Interest rate %',
      aliases: ['Interest Rate', 'Interest Rate Pct', 'Interest %'],
      hint: "Annual. Zero falls back to the group's rate.",
      min: 0,
      max: 100,
    }),
    number<CustomerDraft>({
      key: 'interestGraceDays',
      label: 'Interest grace (days)',
      aliases: ['Interest Grace', 'Grace Days', 'Grace'],
      min: 0,
      max: 365,
      integer: true,
    }),
    choice<CustomerDraft>({
      key: 'statementCycle',
      label: 'Statement cycle',
      aliases: ['Statement Cycle', 'Cycle', 'Statement Frequency'],
      options: CYCLES,
      example: 'Monthly',
    }),
    number<CustomerDraft>({
      key: 'statementAnchorDay',
      label: 'Statement day',
      aliases: ['Statement Day', 'Statement Anchor Day', 'Month End Day'],
      hint: 'Day of the month a monthly statement closes on.',
      min: 1,
      max: 31,
      integer: true,
    }),
    date<CustomerDraft>({
      key: 'statementAnchorDate',
      label: 'Cycle start date',
      aliases: ['Cycle Start', 'Statement Anchor Date', 'Anchor Date'],
      hint: 'Where a weekly or fortnightly cycle counts from.',
    }),
    text<CustomerDraft>({
      key: 'notes',
      label: 'Notes',
      aliases: ['Notes', 'Comment', 'Comments'],
      max: 2000,
    }),
  ],

  validateRow(draft) {
    const status = draft.status as string | undefined
    if (status && status !== 'active' && !String(draft.statusReason ?? '').trim()) {
      return 'Give a reason when an account is not active.'
    }
    return null
  },

  loadLookups: (siteId) =>
    loadLookups(siteId, { customerGroups: true, salesReps: true, existing: 'customers' }),

  async applyRow(
    ctx: ApplyContext,
    draft: Record<string, unknown>,
    existingId: number | null,
    mode: ExistingMode,
  ): Promise<RowOutcome> {
    const base = { line: 0, code: String(draft.code ?? '') }

    if (existingId !== null && mode === 'skip') {
      return { ...base, status: 'skipped', reason: 'Already on file.' }
    }

    if (existingId !== null) {
      const existing = await getCustomer(ctx.siteId, existingId)
      if (!existing) return { ...base, status: 'failed', reason: 'It was deleted while this ran.' }

      const result = await updateCustomer(
        ctx.siteId, ctx.actor, existingId,
        mergeForUpdate(toInput(existing), draft, ctx.mapped),
      )
      return result.ok
        ? { ...base, status: 'updated', id: existingId }
        : { ...base, status: 'failed', reason: result.error }
    }

    const result = await createCustomer(ctx.siteId, ctx.actor, {
      ...(draft as CustomerInput),
      code: String(draft.code ?? ''),
      name: String(draft.name ?? ''),
    })
    return result.ok
      ? { ...base, status: 'created', id: result.id }
      : { ...base, status: 'failed', reason: result.error }
  },
}

/**
 * The stored customer as the shape its own update function takes.
 *
 * Everything dropped here is derived rather than settable: `balance` and the
 * three credit figures come from the ledger, the two names are joins, and the
 * timestamps are the database's. Passing any of them back would either be
 * ignored or, worse, quietly accepted as a new truth.
 */
function toInput(customer: Customer): CustomerInput {
  const {
    id, balance, groupName, repName, createdAt, updatedAt,
    overLimit, availableCredit, canBuyOnAccount,
    ...rest
  } = customer
  void id; void balance; void groupName; void repName
  void createdAt; void updatedAt
  void overLimit; void availableCredit; void canBuyOnAccount
  return rest
}

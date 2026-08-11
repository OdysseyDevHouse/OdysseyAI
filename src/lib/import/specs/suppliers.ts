import 'server-only'
import {
  createSupplier, updateSupplier, getSupplier,
  type SupplierInput, type Supplier,
} from '@/lib/site/suppliers'
import { loadLookups } from '../lookups'
import { mergeForUpdate } from '../merge'
import { text, number, choice } from '../fields'
import type {
  ApplyContext, ExistingMode, ImportSpec, RowOutcome,
} from '../spec'

/**
 * Importing suppliers.
 *
 * The flattest of the imports — no foreign keys at all, one row in, one row
 * out. It is here mainly because products reference suppliers by code, so a
 * shop switching systems has to load these first, and because it is the
 * simplest place to see the update rule working before products complicates it.
 */

export type SupplierDraft = Partial<SupplierInput>

const STATUSES = {
  Active: 'active',
  'On hold': 'on_hold',
  Inactive: 'inactive',
  Closed: 'closed',
} as const

export const supplierSpec: ImportSpec<SupplierDraft> = {
  entity: 'suppliers',
  title: 'Suppliers',
  singular: 'supplier',
  description: 'Who you buy from. Load these before products, so a product can name its supplier.',
  capability: 'suppliers.edit',
  matchKey: 'code',

  fields: [
    text<SupplierDraft>({
      key: 'code',
      label: 'Code',
      aliases: ['Code', 'Supplier Code', 'Account Code', 'Acc Code'],
      hint: 'Leave the column out entirely to have codes generated.',
      example: 'SUP001',
      max: 32,
    }),
    text<SupplierDraft>({
      key: 'name',
      label: 'Name',
      aliases: ['Name', 'Supplier Name', 'Supplier', 'Company'],
      required: true,
      example: 'Acme Trading (Pty) Ltd',
      max: 160,
    }),
    choice<SupplierDraft>({
      key: 'status',
      label: 'Status',
      aliases: ['Status'],
      options: STATUSES,
      hint: 'Anything other than Active needs a Status Reason.',
      example: 'Active',
    }),
    text<SupplierDraft>({
      key: 'statusReason',
      label: 'Status reason',
      aliases: ['Status Reason', 'Reason'],
      max: 190,
    }),
    text<SupplierDraft>({
      key: 'contactName',
      label: 'Contact',
      aliases: ['Contact', 'Contact Name', 'Contact Person'],
      example: 'Jane Dlamini',
      max: 120,
    }),
    text<SupplierDraft>({
      key: 'email',
      label: 'Email',
      aliases: ['Email', 'Email Address', 'E-mail'],
      example: 'orders@acme.co.za',
      max: 190,
      blankClears: true,
    }),
    text<SupplierDraft>({
      key: 'phone',
      label: 'Phone',
      aliases: ['Phone', 'Telephone', 'Tel', 'Contact Number'],
      example: '021 555 0100',
      max: 40,
      blankClears: true,
    }),
    text<SupplierDraft>({
      key: 'addressLine1',
      label: 'Address line 1',
      aliases: ['Address', 'Address Line 1', 'Address1', 'Street'],
      example: '12 Loop Street',
      max: 190,
    }),
    text<SupplierDraft>({
      key: 'addressLine2',
      label: 'Address line 2',
      aliases: ['Address Line 2', 'Address2', 'Suburb'],
      max: 190,
    }),
    text<SupplierDraft>({
      key: 'city',
      label: 'City',
      aliases: ['City', 'Town'],
      example: 'Cape Town',
      max: 120,
    }),
    text<SupplierDraft>({
      key: 'postalCode',
      label: 'Postal code',
      aliases: ['Postal Code', 'Post Code', 'Zip', 'Postcode'],
      example: '8001',
      max: 20,
    }),
    text<SupplierDraft>({
      key: 'vatNumber',
      label: 'VAT number',
      aliases: ['VAT Number', 'VAT No', 'VAT Reg', 'Tax Number'],
      example: '4123456789',
      max: 40,
    }),
    text<SupplierDraft>({
      key: 'accountNumber',
      label: 'Our account number',
      aliases: ['Account Number', 'Account No', 'Our Account'],
      hint: 'The number THEY know you by, quoted on their invoices.',
      max: 60,
    }),
    number<SupplierDraft>({
      key: 'paymentTermsDays',
      label: 'Payment terms (days)',
      aliases: ['Payment Terms', 'Terms', 'Terms Days', 'Payment Days'],
      min: 0,
      max: 365,
      integer: true,
      example: '30',
    }),
    number<SupplierDraft>({
      key: 'settlementDiscountDays',
      label: 'Settlement discount days',
      aliases: ['Settlement Discount Days', 'Discount Days'],
      hint: "'2/10 net 30' is 10 days here, 2 percent below, and 30 in the terms above.",
      min: 0,
      max: 365,
      integer: true,
    }),
    number<SupplierDraft>({
      key: 'settlementDiscountPct',
      label: 'Settlement discount %',
      aliases: ['Settlement Discount', 'Settlement Discount Pct', 'Discount %'],
      min: 0,
      max: 99.999,
    }),
    number<SupplierDraft>({
      key: 'leadTimeDays',
      label: 'Lead time (days)',
      aliases: ['Lead Time', 'Lead Time Days', 'Delivery Days'],
      min: 0,
      max: 365,
      integer: true,
      example: '7',
    }),
    number<SupplierDraft>({
      key: 'minimumOrder',
      label: 'Minimum order',
      aliases: ['Minimum Order', 'Min Order', 'Minimum Order Value'],
      min: 0,
    }),
    text<SupplierDraft>({
      key: 'bankName',
      label: 'Bank',
      aliases: ['Bank', 'Bank Name'],
      max: 120,
    }),
    text<SupplierDraft>({
      key: 'bankBranch',
      label: 'Branch',
      aliases: ['Branch', 'Bank Branch', 'Branch Code'],
      max: 60,
    }),
    text<SupplierDraft>({
      key: 'bankAccount',
      label: 'Bank account',
      aliases: ['Bank Account', 'Account', 'Bank Account Number'],
      max: 60,
    }),
    text<SupplierDraft>({
      key: 'category',
      label: 'Category',
      aliases: ['Category', 'Type', 'Supplier Category'],
      example: 'Groceries',
      max: 60,
    }),
    text<SupplierDraft>({
      key: 'notes',
      label: 'Notes',
      aliases: ['Notes', 'Comment', 'Comments'],
      max: 2000,
    }),
  ],

  // A non-active account with no reason is refused by validateSupplier anyway.
  // Catching it here means the review screen shows every such row at once,
  // rather than the run stopping on them one at a time after writing has begun.
  validateRow(draft) {
    const status = draft.status as string | undefined
    if (status && status !== 'active' && !String(draft.statusReason ?? '').trim()) {
      return 'Give a reason when an account is not active.'
    }
    return null
  },

  loadLookups: (siteId) => loadLookups(siteId, { existing: 'suppliers' }),

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
      const existing = await getSupplier(ctx.siteId, existingId)
      if (!existing) return { ...base, status: 'failed', reason: 'It was deleted while this ran.' }

      const result = await updateSupplier(
        ctx.siteId, ctx.actor, existingId,
        mergeForUpdate(toInput(existing), draft, ctx.mapped),
      )
      return result.ok
        ? { ...base, status: 'updated', id: existingId }
        : { ...base, status: 'failed', reason: result.error }
    }

    const result = await createSupplier(ctx.siteId, ctx.actor, {
      ...(draft as SupplierInput),
      code: String(draft.code ?? ''),
      name: String(draft.name ?? ''),
    })
    return result.ok
      ? { ...base, status: 'created', id: result.id }
      : { ...base, status: 'failed', reason: result.error }
  },
}

/**
 * The stored supplier as the shape its own update function takes.
 *
 * `balance` is deliberately dropped: it is written by the ledger, not by this
 * form, and `SupplierInput` has no room for it — which is the schema saying the
 * same thing.
 */
function toInput(supplier: Supplier): SupplierInput {
  const { id, balance, ...rest } = supplier
  void id
  void balance
  return rest
}

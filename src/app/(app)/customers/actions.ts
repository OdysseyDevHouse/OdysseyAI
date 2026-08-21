'use server'

import { toAccountType } from '@/lib/accountTypes'
import { toStatementCycle } from '@/lib/statementCycles'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireActor, actorForModule, actorForModuleOrThrow } from '@/lib/auth'
import { setValues } from '@/lib/site/customFields'
import type { CustomFieldEntity } from '@/lib/customFieldModel'
import {
  createCustomer,
  updateCustomer,
  deleteCustomer,
  bulkUpdateCustomers,
  toCustomerStatus,
  possibleDuplicates,
  duplicateWarning,
  type BulkChange,
  type BulkResult,
  type CustomerInput,
} from '@/lib/site/customers'
import {
  saveCustomerAddress,
  deleteCustomerAddress,
  type CustomerAddressInput,
} from '@/lib/site/customerAddresses'

export type CustomerFormState = {
  error: string | null
  /**
   * "This might already be on file" — a cell number or email already used by
   * another account.
   *
   * Distinct from `error`, and the difference is the whole design: an error
   * means the save was refused, this means it was PAUSED and pressing Save
   * again will go through. A duplicate code is an error, because the code is
   * unique and there is nothing to decide; a shared cell number is this,
   * because a husband and wife on one mobile are two real customers.
   *
   * The form echoes it back as `confirmedDuplicate` on the next submit, which
   * is what makes the second press mean "yes, I read it".
   */
  duplicateWarning?: string | null
  /**
   * Everything that was typed, so the form can put it back.
   *
   * The customer form's inputs are UNCONTROLLED — defaultValue, read out of
   * FormData on submit — which is right for a form that either saves and
   * redirects or fails outright. A warning does neither: it returns to the same
   * mounted form, React re-renders, and every defaultValue snaps back to what
   * it held when the page loaded.
   *
   * Measured rather than assumed. Driving the real screen over CDP, the second
   * press posted `code= name= ack=1` — an empty form that then failed
   * validation on a blank name, so the warning made the customer harder to
   * create rather than easier.
   *
   * Only set alongside duplicateWarning. A successful save redirects and a
   * refused one keeps the live DOM values, because neither re-keys the inputs.
   */
  values?: Record<string, string> | null
}

/**
 * The submitted form as plain strings, for echoing back with a warning.
 *
 * Files and the acknowledgement itself are dropped: the ack is re-rendered from
 * the warning, and a File has no defaultValue to restore.
 */
function formValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (key === 'confirmedDuplicate') continue
    if (typeof value === 'string') values[key] = value
  }
  return values
}

function optionalId(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function num(form: FormData, key: string, fallback = 0): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return fallback
  // A comma decimal is what a South African keyboard produces; accept it rather
  // than silently reading "1,50" as 1.
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

function text(form: FormData, key: string): string | null {
  return String(form.get(key) ?? '').trim() || null
}

function readInput(form: FormData): CustomerInput {
  return {
    code: String(form.get('code') ?? ''),
    name: String(form.get('name') ?? ''),
    status: toCustomerStatus(form.get('status')) ?? 'active',
    statusReason: text(form, 'statusReason'),
    accountType: toAccountType(form.get('accountType')),
    contactName: text(form, 'contactName'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    addressLine1: text(form, 'addressLine1'),
    addressLine2: text(form, 'addressLine2'),
    city: text(form, 'city'),
    postalCode: text(form, 'postalCode'),
    vatNumber: text(form, 'vatNumber'),
    groupId: optionalId(form, 'groupId'),
    repId: optionalId(form, 'repId'),
    category: text(form, 'category'),
    paymentTermsDays: num(form, 'paymentTermsDays', 30),
    // Only the anchor field for the chosen cycle is rendered, so the other
    // posts nothing and falls back to its default — which is what we want.
    statementCycle: toStatementCycle(form.get('statementCycle')),
    statementAnchorDay: num(form, 'statementAnchorDay', 0),
    statementAnchorDate: text(form, 'statementAnchorDate'),
    creditLimit: num(form, 'creditLimit', 0),
    dailyLimit: num(form, 'dailyLimit', 0),
    monthlyLimit: num(form, 'monthlyLimit', 0),
    // A Checkbox posts nothing when off, so absence means false — same as
    // interestEnabled below.
    autoEmailInvoices: form.get('autoEmailInvoices') !== null,
    priceStructureId: optionalId(form, 'priceStructureId'),
    // Blank means NO standing discount — distinct from an explicit 0.
    discountPct: String(form.get('discountPct') ?? '').trim()
      ? num(form, 'discountPct', 0)
      : null,
    // A Switch posts nothing when off, so absence means false.
    interestEnabled: form.get('interestEnabled') !== null,
    interestRatePct: num(form, 'interestRatePct', 0),
    interestGraceDays: num(form, 'interestGraceDays', 0),
    notes: text(form, 'notes'),
  }
}

export async function saveCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  /*
   * The duplicate check, before either write.
   *
   * Skipped once the person has seen the warning and pressed Save again — the
   * hidden field carries that acknowledgement back. Without the skip the same
   * warning would reappear forever and the account could never be created,
   * which is worse than no check at all.
   *
   * It runs on EDIT as well as create: changing a customer's cell number to one
   * another account already uses is the same mistake arriving by a different
   * road. excludeId keeps an unchanged save from warning about itself.
   */
  if (form.get('confirmedDuplicate') === null) {
    const matches = await possibleDuplicates(
      siteId,
      { phone: input.phone, email: input.email },
      idRaw ? Number(idRaw) : undefined,
    )
    if (matches.length > 0) {
      return {
        error: null,
        duplicateWarning: duplicateWarning(matches),
        values: formValues(form),
      }
    }
  }

  const result = idRaw
    ? await updateCustomer(siteId, actor, Number(idRaw), input)
    : await createCustomer(siteId, actor, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/customers')
  redirect(`/customers/${result.id}?saved=1`)
}

export async function deleteCustomerAction(form: FormData): Promise<void> {
  const ctx = await actorForModuleOrThrow('customers', 'customers.edit')
  const { siteId, actor } = ctx
  const id = Number(form.get('id'))
  if (!Number.isFinite(id) || id <= 0) redirect('/customers')

  const result = await deleteCustomer(siteId, actor, id)
  if (!result.ok) {
    // Round-tripped through the URL because a fire-and-redirect action has no
    // form state to return into — the detail page renders it as a banner.
    redirect(`/customers/${id}?error=${encodeURIComponent(result.error)}`)
  }

  revalidatePath('/customers')
  redirect('/customers?deleted=1')
}

/**
 * Applies one change to many accounts.
 *
 * Returns the outcome rather than redirecting, so the list screen can report
 * "38 updated, 2 skipped" with the reasons — a bulk action that silently drops
 * rows is worse than one that refuses outright.
 */
export async function bulkUpdateCustomersAction(
  ids: number[],
  change: BulkChange,
): Promise<BulkResult> {
  const ctx = await actorForModuleOrThrow('customers', 'customers.edit')
  const { siteId, actor } = ctx
  const result = await bulkUpdateCustomers(siteId, actor, ids, change)
  revalidatePath('/customers')
  return result
}

/* ── The address book (132) ──────────────────────────────────────────────── */

export type AddressActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveCustomerAddressAction(
  customerId: number,
  input: CustomerAddressInput,
  id?: number,
): Promise<AddressActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveCustomerAddress(siteId, actor, customerId, input, id)
  if (!result.ok) return result

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: id ? 'Address saved.' : 'Address added.' }
}

export async function deleteCustomerAddressAction(
  customerId: number,
  id: number,
): Promise<AddressActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteCustomerAddress(siteId, actor, customerId, id)
  if (!result.ok) return result

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Address removed.' }
}

/**
 * The custom fields on a customer.
 *
 * Guarded on customers.edit — the field DEFINITIONS are a setup decision, but
 * filling one in is editing the customer, which is what this capability means.
 */
export async function setCustomerCustomValuesAction(
  entity: CustomFieldEntity,
  entityId: number,
  values: { fieldId: number; value: string | null }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }
  // Pinned, as on the job: the shared panel passes the entity from the client,
  // so trusting it here would let a customers.edit holder write job fields.
  if (entity !== 'customer') return { ok: false, error: 'That is not a customer field.' }

  const result = await setValues(ctx.siteId, ctx.actor, 'customer', entityId, values)
  if (result.ok) revalidatePath(`/customers/${entityId}`)
  return result
}

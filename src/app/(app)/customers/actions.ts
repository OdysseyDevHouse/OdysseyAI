'use server'

import { toAccountType } from '@/lib/accountTypes'
import { toStatementCycle } from '@/lib/statementCycles'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireActor, actorFor, actorForOrThrow } from '@/lib/auth'
import { setValues } from '@/lib/site/customFields'
import type { CustomFieldEntity } from '@/lib/customFieldModel'
import {
  createCustomer,
  updateCustomer,
  deleteCustomer,
  bulkUpdateCustomers,
  toCustomerStatus,
  type BulkChange,
  type BulkResult,
  type CustomerInput,
} from '@/lib/site/customers'
import {
  saveCustomerAddress,
  deleteCustomerAddress,
  type CustomerAddressInput,
} from '@/lib/site/customerAddresses'

export type CustomerFormState = { error: string | null }

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
    loyaltyNumber: text(form, 'loyaltyNumber'),
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
  const ctx = await actorFor('customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateCustomer(siteId, actor, Number(idRaw), input)
    : await createCustomer(siteId, actor, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/customers')
  redirect(`/customers/${result.id}?saved=1`)
}

export async function deleteCustomerAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('customers.edit')
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
  const ctx = await actorForOrThrow('customers.edit')
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
  const ctx = await actorFor('customers.edit')
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
  const ctx = await actorFor('customers.edit')
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
  const ctx = await actorFor('customers.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }
  // Pinned, as on the job: the shared panel passes the entity from the client,
  // so trusting it here would let a customers.edit holder write job fields.
  if (entity !== 'customer') return { ok: false, error: 'That is not a customer field.' }

  const result = await setValues(ctx.siteId, ctx.actor, 'customer', entityId, values)
  if (result.ok) revalidatePath(`/customers/${entityId}`)
  return result
}

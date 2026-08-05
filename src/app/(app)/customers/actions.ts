'use server'

import { toAccountType } from '@/lib/accountTypes'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireActor } from '@/lib/auth'
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
    creditLimit: num(form, 'creditLimit', 0),
    notes: text(form, 'notes'),
  }
}

export async function saveCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const { siteId, actor } = await requireActor()
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
  const { siteId, actor } = await requireActor()
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
  const { siteId, actor } = await requireActor()
  const result = await bulkUpdateCustomers(siteId, actor, ids, change)
  revalidatePath('/customers')
  return result
}

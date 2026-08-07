'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireActor, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  createSupplier,
  updateSupplier,
  deleteSupplier,
  bulkUpdateSuppliers,
  toSupplierStatus,
  type SupplierBulkChange,
  type SupplierBulkResult,
  type SupplierInput,
} from '@/lib/site/suppliers'

export type SupplierFormState = { error: string | null }

function num(form: FormData, key: string, fallback = 0): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

function text(form: FormData, key: string): string | null {
  return String(form.get(key) ?? '').trim() || null
}

function readInput(form: FormData): SupplierInput {
  return {
    code: String(form.get('code') ?? ''),
    name: String(form.get('name') ?? ''),
    status: toSupplierStatus(form.get('status')) ?? 'active',
    statusReason: text(form, 'statusReason'),
    contactName: text(form, 'contactName'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    addressLine1: text(form, 'addressLine1'),
    addressLine2: text(form, 'addressLine2'),
    city: text(form, 'city'),
    postalCode: text(form, 'postalCode'),
    vatNumber: text(form, 'vatNumber'),
    accountNumber: text(form, 'accountNumber'),
    paymentTermsDays: num(form, 'paymentTermsDays', 30),
    settlementDiscountDays: num(form, 'settlementDiscountDays', 0),
    settlementDiscountPct: num(form, 'settlementDiscountPct', 0),
    leadTimeDays: num(form, 'leadTimeDays', 0),
    minimumOrder: num(form, 'minimumOrder', 0),
    bankName: text(form, 'bankName'),
    bankBranch: text(form, 'bankBranch'),
    bankAccount: text(form, 'bankAccount'),
    category: text(form, 'category'),
    notes: text(form, 'notes'),
  }
}

export async function saveSupplierAction(
  _prev: SupplierFormState,
  form: FormData,
): Promise<SupplierFormState> {
  const ctx = await actorFor('suppliers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateSupplier(siteId, actor, Number(idRaw), input)
    : await createSupplier(siteId, actor, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/suppliers')
  redirect(`/suppliers/${result.id}?saved=1`)
}

export async function deleteSupplierAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('suppliers.edit')
  const { siteId, actor } = ctx
  const id = Number(form.get('id'))
  if (!Number.isFinite(id) || id <= 0) redirect('/suppliers')

  const result = await deleteSupplier(siteId, actor, id)
  if (!result.ok) {
    redirect(`/suppliers/${id}?error=${encodeURIComponent(result.error)}`)
  }

  revalidatePath('/suppliers')
  redirect('/suppliers?deleted=1')
}

export async function bulkUpdateSuppliersAction(
  ids: number[],
  change: SupplierBulkChange,
): Promise<SupplierBulkResult> {
  const ctx = await actorForOrThrow('suppliers.edit')
  const { siteId, actor } = ctx
  const result = await bulkUpdateSuppliers(siteId, actor, ids, change)
  revalidatePath('/suppliers')
  return result
}

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSession, requireStoreId, canEdit } from '@/lib/auth'
import {
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  type SupplierInput,
} from '@/lib/suppliers'

export type SupplierFormState = { error: string | null }

function text(form: FormData, key: string): string | null {
  const raw = String(form.get(key) ?? '').trim()
  return raw || null
}

function readInput(form: FormData): SupplierInput {
  const termsRaw = String(form.get('paymentTermsDays') ?? '').trim()
  const terms = Number(termsRaw)

  return {
    code: String(form.get('code') ?? ''),
    name: String(form.get('name') ?? ''),
    contactName: text(form, 'contactName'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    addressLine1: text(form, 'addressLine1'),
    addressLine2: text(form, 'addressLine2'),
    city: text(form, 'city'),
    postalCode: text(form, 'postalCode'),
    vatNumber: text(form, 'vatNumber'),
    accountNumber: text(form, 'accountNumber'),
    paymentTermsDays: Number.isFinite(terms) ? terms : 30,
    isActive: form.get('isActive') === 'on',
    notes: text(form, 'notes'),
  }
}

export async function saveSupplierAction(
  _prev: SupplierFormState,
  form: FormData,
): Promise<SupplierFormState> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) return { error: 'You do not have permission to edit suppliers.' }

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateSupplier(storeId, session.userId, Number(idRaw), input)
    : await createSupplier(storeId, session.userId, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/suppliers')
  revalidatePath('/dashboard')
  redirect(`/suppliers/${result.id}`)
}

export async function deactivateSupplierAction(form: FormData): Promise<void> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) redirect('/suppliers')

  const id = Number(form.get('id'))
  if (Number.isFinite(id) && id > 0) {
    await deactivateSupplier(storeId, session.userId, id)
  }

  revalidatePath('/suppliers')
  redirect('/suppliers')
}

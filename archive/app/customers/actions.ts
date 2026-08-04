'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSession, requireStoreId, canEdit } from '@/lib/auth'
import {
  createCustomer,
  updateCustomer,
  deactivateCustomer,
  type CustomerInput,
} from '@/lib/customers'

export type CustomerFormState = { error: string | null }

function text(form: FormData, key: string): string | null {
  const raw = String(form.get(key) ?? '').trim()
  return raw || null
}

function readInput(form: FormData): CustomerInput {
  const limitRaw = String(form.get('creditLimit') ?? '').trim()
  const limit = Number(limitRaw.replace(/,/g, ''))

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
    loyaltyNumber: text(form, 'loyaltyNumber'),
    creditLimit: Number.isFinite(limit) ? limit : 0,
    onHold: form.get('onHold') === 'on',
    isActive: form.get('isActive') === 'on',
    notes: text(form, 'notes'),
  }
}

export async function saveCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) return { error: 'You do not have permission to edit customers.' }

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateCustomer(storeId, session.userId, Number(idRaw), input)
    : await createCustomer(storeId, session.userId, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/customers')
  revalidatePath('/dashboard')
  redirect(`/customers/${result.id}`)
}

export async function deactivateCustomerAction(form: FormData): Promise<void> {
  const session = await requireSession()
  const storeId = await requireStoreId()
  if (!canEdit(session)) redirect('/customers')

  const id = Number(form.get('id'))
  if (Number.isFinite(id) && id > 0) {
    const result = await deactivateCustomer(storeId, session.userId, id)
    // An outstanding balance blocks deactivation; send them back to the record
    // so the message on the page still makes sense.
    if (!result.ok) redirect(`/customers/${id}?error=${encodeURIComponent(result.error ?? '')}`)
  }

  revalidatePath('/customers')
  redirect('/customers')
}

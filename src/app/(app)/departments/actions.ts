'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  createDepartment,
  updateDepartment,
  deleteDepartment,
  type DepartmentInput,
} from '@/lib/site/departments'

export type DepartmentFormState = { error: string | null }

function optionalId(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function readInput(form: FormData): DepartmentInput {
  const sortRaw = String(form.get('sortOrder') ?? '').trim()
  const sort = Number(sortRaw)

  return {
    name: String(form.get('name') ?? ''),
    parentId: optionalId(form, 'parentId'),
    code: String(form.get('code') ?? '') || null,
    color: String(form.get('color') ?? '') || null,
    sortOrder: Number.isFinite(sort) ? sort : 0,
    isActive: form.get('isActive') === 'on',
  }
}

export async function saveDepartmentAction(
  _prev: DepartmentFormState,
  form: FormData,
): Promise<DepartmentFormState> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  const result = idRaw
    ? await updateDepartment(siteId, Number(idRaw), input)
    : await createDepartment(siteId, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/departments')
  // Product forms cache their department list.
  revalidatePath('/products')
  redirect('/departments?saved=1')
}

export async function deleteDepartmentAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('products.edit')
  const { siteId } = ctx
  const id = Number(form.get('id'))

  if (!Number.isFinite(id) || id <= 0) redirect('/departments')

  const result = await deleteDepartment(siteId, id)

  revalidatePath('/departments')
  revalidatePath('/products')

  // Deletion is refused when children or products still depend on it — send the
  // reason back to the record rather than dropping it.
  if (!result.ok) {
    redirect(`/departments/${id}?error=${encodeURIComponent(result.error)}`)
  }
  redirect('/departments?deleted=1')
}

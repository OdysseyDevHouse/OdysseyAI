'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getDepartment,
  patchDepartment,
  reorderDepartments,
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

/**
 * The inline controls on the list — colour, active switch, drag-to-reorder,
 * and the quick editor.
 *
 * These return a result instead of redirecting: the list patches itself
 * optimistically and only needs to know whether to keep the change or put it
 * back. A redirect would throw the whole tree's expand state away on every
 * switch flip.
 */
export type InlineResult = { ok: boolean; error?: string; message?: string }

/** Revalidates everything a department change is visible in. */
function revalidateDepartments(): void {
  revalidatePath('/departments')
  // Product forms and filters cache their department list.
  revalidatePath('/products')
}

export async function setDepartmentColorAction(
  id: number,
  color: string | null,
): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await patchDepartment(ctx.siteId, id, { color })
  if (!result.ok) return { ok: false, error: result.error }

  revalidateDepartments()
  return { ok: true, message: color ? 'Colour set.' : 'Colour cleared.' }
}

export async function setDepartmentActiveAction(
  id: number,
  isActive: boolean,
): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await patchDepartment(ctx.siteId, id, { isActive })
  if (!result.ok) return { ok: false, error: result.error }

  revalidateDepartments()
  return { ok: true, message: isActive ? 'Department activated.' : 'Department deactivated.' }
}

export async function reorderDepartmentsAction(orderedIds: number[]): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await reorderDepartments(ctx.siteId, orderedIds)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateDepartments()
  return { ok: true, message: 'Order saved.' }
}

/**
 * Create or rename from the list's own modal, without leaving the page.
 *
 * The full form at /departments/[id] still owns code, sort order and
 * re-parenting — this covers only what the list itself offers.
 */
export async function quickSaveDepartmentAction(input: {
  id?: number
  name: string
  parentId: number | null
  color: string | null
}): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  let result
  if (input.id) {
    // updateDepartment rewrites the whole row, so the fields this modal does
    // not offer must be carried over from the record as it stands — passing
    // the defaults would silently blank a code and reset the sort order.
    const existing = await getDepartment(siteId, input.id)
    if (!existing) return { ok: false, error: 'Department not found.' }

    result = await updateDepartment(siteId, input.id, {
      name: input.name,
      parentId: input.parentId,
      color: input.color,
      code: existing.code,
      sortOrder: existing.sortOrder,
      isActive: existing.isActive,
    })
  } else {
    result = await createDepartment(siteId, {
      name: input.name,
      parentId: input.parentId,
      color: input.color,
    })
  }

  if (!result.ok) return { ok: false, error: result.error }

  revalidateDepartments()
  return { ok: true, message: input.id ? 'Department saved.' : 'Department created.' }
}

export async function deleteDepartmentInlineAction(id: number): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteDepartment(ctx.siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateDepartments()
  return { ok: true, message: 'Department deleted.' }
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

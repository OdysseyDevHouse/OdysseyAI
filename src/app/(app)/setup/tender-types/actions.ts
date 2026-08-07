'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, actorFor } from '@/lib/auth'
import {
  createTenderType,
  updateTenderType,
  deleteTenderType,
  reorderTenderTypes,
  type TenderInput,
} from '@/lib/site/tenderTypes'

export type TenderActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveTenderTypeAction(
  id: number | null,
  input: TenderInput,
): Promise<TenderActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id
    ? await updateTenderType(siteId, id, input)
    : await createTenderType(siteId, input)

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/tender-types')
  return { ok: true, message: id ? 'Tender updated.' : 'Tender added.' }
}

export async function deleteTenderTypeAction(id: number): Promise<TenderActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await deleteTenderType(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/tender-types')
  return { ok: true, message: 'Tender removed.' }
}

export async function reorderTenderTypesAction(orderedIds: number[]): Promise<TenderActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  await reorderTenderTypes(siteId, orderedIds)
  revalidatePath('/setup/tender-types')
  return { ok: true, message: 'Order saved.' }
}

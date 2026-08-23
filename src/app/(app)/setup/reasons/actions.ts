'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  deleteSalesReason,
  saveSalesReason,
  type ReasonKind,
  type SalesReasonInput,
} from '@/lib/site/salesReasons'

/**
 * Maintaining the two sales reason lists.
 *
 * One pair of actions for both kinds rather than four: the shapes are identical
 * and the kind is a parameter the lib already takes. It is validated against the
 * two known values here regardless — this is a server action, so `kind` arrives
 * from a client and must not be able to name a table.
 */

function validKind(kind: ReasonKind): boolean {
  return kind === 'void' || kind === 'return'
}

/** Which screens go stale when a list changes. Both tills and both forms read them. */
function revalidateReasonScreens(kind: ReasonKind) {
  revalidatePath('/setup/reasons')
  revalidatePath('/pos')
  if (kind === 'void') {
    revalidatePath('/invoicing')
  } else {
    revalidatePath('/sales/returns')
  }
}

export async function saveSalesReasonAction(
  kind: ReasonKind,
  input: SalesReasonInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!validKind(kind)) return { ok: false, error: 'Unknown reason list.' }

  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await saveSalesReason(ctx.siteId, kind, input, id)
  if (!result.ok) return result

  revalidateReasonScreens(kind)
  return result
}

export async function deleteSalesReasonAction(
  kind: ReasonKind,
  id: number,
): Promise<{ ok: true; retired: boolean } | { ok: false; error: string }> {
  if (!validKind(kind)) return { ok: false, error: 'Unknown reason list.' }

  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteSalesReason(ctx.siteId, kind, id)
  if (!result.ok) return result

  revalidateReasonScreens(kind)
  return result
}

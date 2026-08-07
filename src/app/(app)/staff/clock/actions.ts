'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { clock, closeForgotten } from '@/lib/site/staffTime'

/**
 * Clocking actions.
 *
 * `clockAction` is deliberately NOT capability-gated at the caller: the PIN is
 * the credential, and the person tapping it is usually not the person signed
 * into the browser. `clock()` resolves the PIN to a user and checks THEIR
 * `staff.clock` — which is the check that matters, and the one a shared
 * terminal needs.
 */
export async function clockAction(
  pin: string,
  terminalId: number | null,
): Promise<
  { ok: true; action: 'in' | 'out'; userName: string; at: string } | { ok: false; error: string }
> {
  const siteId = await requireSiteId()

  const result = await clock(siteId, pin, terminalId)
  if (!result.ok) return result

  revalidatePath('/staff/clock')
  return {
    ok: true,
    action: result.action,
    userName: result.userName,
    at: result.action === 'in' ? result.entry.startedAt : (result.entry.endedAt ?? ''),
  }
}

/** A manager closing an entry somebody forgot. Needs staff.edit. */
export async function closeForgottenAction(
  entryId: number,
  endedAt: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) {
    return { ok: false, error: 'You do not have permission to correct hours.' }
  }

  const result = await closeForgotten(ctx.site.id, entryId, endedAt, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/clock')
  return { ok: true, message: 'Closed, and the correction is on the record.' }
}

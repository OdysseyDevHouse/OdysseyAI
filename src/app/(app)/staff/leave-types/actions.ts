'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createLeaveType,
  updateLeaveType,
  deleteLeaveType,
  type LeaveTypeInput,
} from '@/lib/site/leave'

/**
 * Leave types — what everybody accrues.
 *
 * Guarded on `staff.edit`, the capability that already governs correcting
 * somebody's leave: a person who may not amend one balance must not be able to
 * change what the whole team earns. A server action is a public endpoint
 * whatever the menu shows, so this is checked here and not only on the page.
 */

type Result = { ok: true; message: string } | { ok: false; error: string }

/** Every leave screen reads these, so all of them are stale once one changes. */
function revalidateLeave() {
  revalidatePath('/staff/leave-types')
  revalidatePath('/staff/leave')
  revalidatePath('/staff/cost')
}

export async function saveLeaveTypeAction(
  typeId: number | null,
  input: LeaveTypeInput,
): Promise<Result> {
  const ctx = await actorFor('staff.edit')
  if ('ok' in ctx) return ctx

  const result = typeId
    ? await updateLeaveType(ctx.siteId, typeId, input)
    : await createLeaveType(ctx.siteId, input)
  if (!result.ok) return result

  revalidateLeave()
  return {
    ok: true,
    // Said rather than implied: changing a rate does not retrospectively post
    // the difference, and somebody who expects balances to jump needs to know
    // to run Accrue on the leave screen.
    message: typeId
      ? `“${input.name.trim()}” saved. Run Accrue on the leave screen to post the change.`
      : `“${input.name.trim()}” added.`,
  }
}

export async function deleteLeaveTypeAction(typeId: number): Promise<Result> {
  const ctx = await actorFor('staff.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteLeaveType(ctx.siteId, typeId)
  if (!result.ok) return result

  revalidateLeave()
  return { ok: true, message: 'Leave type deleted.' }
}

'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { approveRange, unapproveRange } from '@/lib/site/timesheets'
import { editEntry, createManual, deleteEntry } from '@/lib/site/staffTime'

/**
 * Timesheet actions.
 *
 * `staff.edit` corrects hours; `staff.approve` signs them off. Split because
 * they are different acts: the supervisor who fixes a forgotten clock-out is
 * often not the person who decides what gets paid.
 */
type Result = { ok: true; message: string } | { ok: false; error: string }

const DENIED_EDIT = { ok: false as const, error: 'You do not have permission to correct hours.' }
const DENIED_APPROVE = { ok: false as const, error: 'You do not have permission to approve hours.' }

export async function approveAction(userId: number, from: string, to: string): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.approve')) return DENIED_APPROVE

  const result = await approveRange(ctx.site.id, userId, from, to, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/timesheets')
  return {
    ok: true,
    message: `${result.approved} ${result.approved === 1 ? 'shift' : 'shifts'} approved.`,
  }
}

export async function unapproveAction(userId: number, from: string, to: string): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.approve')) return DENIED_APPROVE

  const result = await unapproveRange(ctx.site.id, userId, from, to)
  if (!result.ok) return result

  revalidatePath('/staff/timesheets')
  return { ok: true, message: 'Reopened. The hours can be corrected again.' }
}

export async function editEntryAction(
  entryId: number,
  input: { startedAt: string; endedAt: string | null; breakMinutes: number; note: string | null },
  reason: string,
): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) return DENIED_EDIT

  const result = await editEntry(ctx.site.id, entryId, input, reason, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/timesheets')
  return { ok: true, message: 'Corrected, and the change is on the record.' }
}

export async function addEntryAction(input: {
  userId: number
  startedAt: string
  endedAt: string | null
  breakMinutes: number
  note: string | null
}): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) return DENIED_EDIT

  const result = await createManual(ctx.site.id, input, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/timesheets')
  return { ok: true, message: 'Shift added.' }
}

export async function deleteEntryAction(entryId: number): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) return DENIED_EDIT

  const result = await deleteEntry(ctx.site.id, entryId)
  if (!result.ok) return result

  revalidatePath('/staff/timesheets')
  return { ok: true, message: 'Shift removed.' }
}

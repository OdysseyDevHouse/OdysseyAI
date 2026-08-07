'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  requestLeave,
  approveRequest,
  declineRequest,
  cancelRequest,
  adjustBalance,
  accrueAll,
  type RequestInput,
} from '@/lib/site/leave'
import { localDay, type LedgerSource } from '@/lib/leaveModel'

/**
 * Leave actions.
 *
 * Booking is guarded by `staff.view_own` rather than `staff.edit`: everybody
 * books their OWN leave, and needing an edit permission to ask for a day off
 * would mean only managers could. Booking on somebody ELSE's behalf needs
 * `staff.edit`, which is the check below.
 */
type Result = { ok: true; message: string } | { ok: false; error: string }

export async function requestLeaveAction(input: RequestInput): Promise<Result> {
  const ctx = await requireSiteUser()

  const forSomeoneElse = input.userId !== ctx.user.id
  const allowed = forSomeoneElse
    ? can(ctx.capabilities, 'staff.edit')
    : can(ctx.capabilities, 'staff.view_own') || can(ctx.capabilities, 'staff.view_all')

  if (!allowed) {
    return {
      ok: false,
      error: forSomeoneElse
        ? 'You can only book your own leave.'
        : 'You do not have permission to book leave.',
    }
  }

  // Going below zero is a deliberate act by somebody who may correct balances,
  // not something a person can do to themselves by asking.
  const result = await requestLeave(ctx.site.id, input, can(ctx.capabilities, 'staff.edit'))
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return {
    ok: true,
    message: forSomeoneElse ? 'Leave booked.' : 'Requested. A manager will decide.',
  }
}

export async function approveLeaveAction(requestId: number, note: string): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.approve')) {
    return { ok: false, error: 'You do not have permission to approve leave.' }
  }

  const result = await approveRequest(ctx.site.id, requestId, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  }, note || null)
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return { ok: true, message: 'Approved, and the days are off their balance.' }
}

export async function declineLeaveAction(requestId: number, note: string): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.approve')) {
    return { ok: false, error: 'You do not have permission to decide leave.' }
  }

  const result = await declineRequest(ctx.site.id, requestId, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  }, note || null)
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return { ok: true, message: 'Declined.' }
}

/**
 * Cancels leave.
 *
 * Somebody may cancel their OWN outstanding request without a permission — it
 * is theirs and nothing has been decided. Cancelling anybody else's, or one
 * already approved, needs `staff.approve`.
 */
export async function cancelLeaveAction(requestId: number, ownerId: number): Promise<Result> {
  const ctx = await requireSiteUser()

  if (ownerId !== ctx.user.id && !can(ctx.capabilities, 'staff.approve')) {
    return { ok: false, error: 'You can only cancel your own leave.' }
  }

  const result = await cancelRequest(ctx.site.id, requestId, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return { ok: true, message: 'Cancelled, and any days are back on the balance.' }
}

export async function adjustBalanceAction(
  userId: number,
  leaveTypeId: number,
  days: number,
  note: string,
  source: LedgerSource,
): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) {
    return { ok: false, error: 'You do not have permission to adjust balances.' }
  }

  const result = await adjustBalance(
    ctx.site.id,
    userId,
    leaveTypeId,
    days,
    note,
    source as 'adjustment' | 'opening' | 'payout' | 'forfeit',
    { userId: ctx.user.id, userName: ctx.user.name },
  )
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return { ok: true, message: 'Balance adjusted, and the reason is on the ledger.' }
}

/**
 * Brings everybody's entitlement up to date.
 *
 * Run by hand rather than on a timer, for now: a store that runs it monthly
 * gets the same answer as one that runs it once a year, because the accrual
 * computes a TOTAL and posts the difference. Nothing is lost by forgetting.
 */
export async function accrueAction(): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.edit')) {
    return { ok: false, error: 'You do not have permission to run accrual.' }
  }

  const result = await accrueAll(ctx.site.id, localDay(new Date()), {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/leave')
  return {
    ok: true,
    message: result.posted
      ? `${result.posted} ${result.posted === 1 ? 'entitlement' : 'entitlements'} updated for ${result.people} ${result.people === 1 ? 'person' : 'people'}.`
      : 'Everybody is already up to date.',
  }
}

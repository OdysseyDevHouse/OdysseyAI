'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  createPayPeriod,
  calculatePayPeriod,
  lockPayPeriod,
  unlockPayPeriod,
} from '@/lib/site/staffCost'

/**
 * Pay period actions.
 *
 * All four need `staff.run` — opening, calculating and locking are one job,
 * and somebody who may freeze a figure for payment is by definition somebody
 * who may see it. Splitting them further would be permission theatre.
 */
type Result = { ok: true; message: string } | { ok: false; error: string }

const DENIED = {
  ok: false as const,
  error: 'You do not have permission to run pay periods.',
}

export async function createPeriodAction(
  periodStart: string,
  periodEnd: string,
  note: string,
): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.run')) return DENIED

  const result = await createPayPeriod(ctx.site.id, periodStart, periodEnd, note)
  if (!result.ok) return result

  revalidatePath('/staff/cost')
  return { ok: true, message: 'Period opened.' }
}

export async function calculatePeriodAction(periodId: number): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.run')) return DENIED

  const result = await calculatePayPeriod(ctx.site.id, periodId)
  if (!result.ok) return result

  revalidatePath('/staff/cost')
  return {
    ok: true,
    message: result.people
      ? `${result.people} ${result.people === 1 ? 'person' : 'people'} costed — R ${result.total.toFixed(2)}.`
      : 'Nobody could be costed. Check that people have a rate on their employment record.',
  }
}

export async function lockPeriodAction(periodId: number): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.run')) return DENIED

  const result = await lockPayPeriod(ctx.site.id, periodId, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/staff/cost')
  return { ok: true, message: 'Locked. These figures will not change again.' }
}

export async function unlockPeriodAction(periodId: number): Promise<Result> {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'staff.run')) return DENIED

  const result = await unlockPayPeriod(ctx.site.id, periodId)
  if (!result.ok) return result

  revalidatePath('/staff/cost')
  return { ok: true, message: 'Reopened. Recalculate before locking it again.' }
}

'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import {
  openShift,
  closeShift,
  recordDrawerMovement,
  shiftPosition,
  openShifts,
} from '@/lib/site/shifts'
import { setSetting, validateSetting } from '@/lib/site/settings'

export type CashupResult = { ok: true; message: string } | { ok: false; error: string }

export async function openShiftAction(
  terminalId: number | null,
  openingFloat: number,
): Promise<CashupResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await openShift(siteId, actor, terminalId, openingFloat)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/cashup')
  return { ok: true, message: 'Shift opened.' }
}

export async function closeShiftAction(
  shiftId: number,
  counted: { tenderTypeId: number; amount: number }[],
  varianceNote?: string,
): Promise<CashupResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await closeShift(siteId, actor, shiftId, counted, varianceNote)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/cashup')
  return {
    ok: true,
    message:
      result.variance === 0
        ? 'Cashed up exactly.'
        : `Cashed up ${result.variance < 0 ? 'short' : 'over'} by ${Math.abs(result.variance).toFixed(2)}.`,
  }
}

export async function drawerMovementAction(
  shiftId: number,
  input: {
    type: 'payout' | 'payin' | 'drop'
    amount: number
    reason: string
    terminalId?: number | null
  },
): Promise<CashupResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await recordDrawerMovement(siteId, actor, shiftId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/cashup')
  return { ok: true, message: 'Recorded.' }
}

/** Live drawer position, for the count screen to check against as it is typed. */
export async function shiftPositionAction(shiftId: number) {
  const { siteId } = await requireActor()
  return shiftPosition(siteId, shiftId)
}


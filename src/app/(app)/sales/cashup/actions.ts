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

/**
 * Switches the site between reconciling by till and by person.
 *
 * REFUSED WHILE ANYTHING IS OPEN. A shift records the mode it was opened under,
 * so switching mid-shift would leave a half-counted drawer being reconciled by
 * one rule while the next sale banks by another — and the person holding the
 * cash would have no way to tell which. Closing everything first is a small
 * inconvenience that makes the change unambiguous.
 */
export async function setCashupModeAction(mode: 'terminal' | 'user'): Promise<CashupResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const open = await openShifts(siteId)
  if (open.length > 0) {
    return {
      ok: false,
      error: `Cash up the ${open.length} open shift${open.length === 1 ? '' : 's'} before changing how this site reconciles.`,
    }
  }

  const invalid = validateSetting('cashup_mode', mode)
  if (invalid) return { ok: false, error: invalid }

  await setSetting(siteId, 'cashup_mode', mode)
  revalidatePath('/sales/cashup')
  return {
    ok: true,
    message:
      mode === 'user'
        ? 'Cash-ups now reconcile per person.'
        : 'Cash-ups now reconcile per till.',
  }
}

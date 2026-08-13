'use server'

import { actorFor } from '@/lib/auth'
import { getTillSession } from '@/lib/tillSession'
import { getUser } from '@/lib/site/users'
import { can, capabilitiesForRole, type CapabilitySet } from '@/lib/site/permissions'
import {
  cashupMode,
  openShift,
  openShiftFor,
  openShiftForUser,
  shiftPosition,
  recordDrawerMovement,
  closeShift,
} from '@/lib/site/shifts'

/**
 * Cash management, from the till.
 *
 * Thin wrappers over shifts.ts — the arithmetic, the modes and the GL mirror
 * all live there, unchanged. What this file adds is SHAPE and GATING:
 *
 *   THE COUNT IS BLIND. The status read returns tender IDENTITIES but never
 *   the expected figures — a cashier who can see what the drawer should hold
 *   is counting towards a number instead of counting the drawer, and the
 *   variance stops meaning anything. `closeShift` computes the variance
 *   server-side from figures this screen never saw.
 *
 *   THE OPERATOR IS WHO ACTS. Writes check the PIN operator's capabilities,
 *   not the browser session's — a manager who signed the browser in that
 *   morning must not leave `sales.cashup` lying on the counter. Same rule as
 *   `operatorCapabilities` in the sales actions, duplicated here rather than
 *   exported from that hotspot.
 */

type Denied = { ok: false; error: string }

/** The PIN operator when one is signed in, else the browser session's user. */
async function operatorFor(
  siteId: number,
  fallback: { actor: { userId: number; userName: string }; capabilities: CapabilitySet },
): Promise<{ actor: { userId: number; userName: string }; capabilities: CapabilitySet }> {
  const till = await getTillSession(siteId)
  if (!till) return fallback
  const operator = await getUser(siteId, till.userId)
  if (!operator) return fallback
  return {
    actor: { userId: operator.id, userName: operator.name },
    capabilities: await capabilitiesForRole(siteId, operator.roleId),
  }
}

const NEEDS_CASHUP =
  'Cash management needs the cash-up right. Ask a manager — they can do it under their own PIN.'

export type TillShiftStatus = {
  mode: 'terminal' | 'user'
  /** Whether the OPERATOR may open/close/move money. The modal states it. */
  canCashup: boolean
  shift: {
    id: number
    openedAt: string
    userName: string
    openingFloat: number
    salesCount: number
  } | null
  /**
   * Tender identities for the count screen — deliberately WITHOUT expected
   * figures. See the header: the count is blind.
   */
  tenders: { tenderTypeId: number; tenderName: string; countsAsDrawerCash: boolean }[]
}

export async function tillShiftStatusAction(
  terminalId: number | null,
): Promise<TillShiftStatus | Denied> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const operator = await operatorFor(siteId, ctx)
  const mode = await cashupMode(siteId)

  const shift =
    mode === 'terminal'
      ? terminalId
        ? await openShiftFor(siteId, terminalId)
        : null
      : await openShiftForUser(siteId, operator.actor.userId)

  if (!shift) {
    return {
      mode,
      canCashup: can(operator.capabilities, 'sales.cashup'),
      shift: null,
      tenders: [],
    }
  }

  const position = await shiftPosition(siteId, shift.id)
  return {
    mode,
    canCashup: can(operator.capabilities, 'sales.cashup'),
    shift: {
      id: shift.id,
      openedAt: shift.openedAt.toISOString(),
      userName: shift.userName,
      openingFloat: shift.openingFloat,
      salesCount: position?.salesCount ?? 0,
    },
    // Identities only — the figures stay on the server.
    tenders: (position?.tenders ?? []).map((t) => ({
      tenderTypeId: t.tenderTypeId,
      tenderName: t.tenderName,
      countsAsDrawerCash: t.countsAsDrawerCash,
    })),
  }
}

export async function tillOpenShiftAction(
  terminalId: number | null,
  openingFloat: number,
): Promise<{ ok: true; shiftId: number } | Denied> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const operator = await operatorFor(siteId, ctx)
  if (!can(operator.capabilities, 'sales.cashup')) return { ok: false, error: NEEDS_CASHUP }

  const result = await openShift(siteId, operator.actor, terminalId, openingFloat)
  if (!result.ok) return result
  return { ok: true, shiftId: result.shiftId }
}

export async function tillDrawerMovementAction(
  shiftId: number,
  input: {
    type: 'payout' | 'payin' | 'drop'
    amount: number
    reason: string
    terminalId?: number | null
  },
): Promise<{ ok: true } | Denied> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const operator = await operatorFor(siteId, ctx)
  if (!can(operator.capabilities, 'sales.cashup')) return { ok: false, error: NEEDS_CASHUP }

  const result = await recordDrawerMovement(siteId, operator.actor, shiftId, input)
  if (!result.ok) return result
  return { ok: true }
}

export async function tillCloseShiftAction(
  shiftId: number,
  counted: { tenderTypeId: number; amount: number }[],
  varianceNote: string | null,
): Promise<{ ok: true; variance: number; withinTolerance: boolean } | Denied> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const operator = await operatorFor(siteId, ctx)
  if (!can(operator.capabilities, 'sales.cashup')) return { ok: false, error: NEEDS_CASHUP }

  return closeShift(siteId, operator.actor, shiftId, counted, varianceNote)
}

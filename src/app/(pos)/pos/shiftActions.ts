'use server'

import { actorFor, withTillOperator } from '@/lib/auth'
import { can, type CapabilitySet } from '@/lib/site/permissions'
import { listUsers } from '@/lib/site/users'
import {
  cashupMode,
  openShift,
  openShiftFor,
  openShiftForUser,
  shiftPosition,
  recordDrawerMovement,
  closeShift,
} from '@/lib/site/shifts'
import {
  declarationView,
  saveDeclaration,
  finalizeDeclaration,
  type DeclarationInput,
} from '@/lib/site/cashupDeclaration'
import {
  visibleFor,
  type VisibleDeclaration,
} from '@/app/(app)/sales/cashup/[shiftId]/declare/visible'

/**
 * Cash management, from the till.
 *
 * Thin wrappers over shifts.ts â€” the arithmetic, the modes and the GL mirror
 * all live there, unchanged. What this file adds is SHAPE and GATING:
 *
 *   THE COUNT IS BLIND. The status read returns tender IDENTITIES but never
 *   the expected figures â€” a cashier who can see what the drawer should hold
 *   is counting towards a number instead of counting the drawer, and the
 *   variance stops meaning anything. `closeShift` computes the variance
 *   server-side from figures this screen never saw.
 *
 *   THE OPERATOR IS WHO ACTS. Writes check the PIN operator's capabilities,
 *   not the browser session's â€” a manager who signed the browser in that
 *   morning must not leave `sales.cashup` lying on the counter. That is
 *   `withTillOperator` in auth.ts, shared with the sales actions; this file
 *   used to hold its own copy, and the drift between the copies is what let
 *   the sales file attribute a sale to the wrong person for so long.
 */

type Denied = { ok: false; error: string }

const NEEDS_CASHUP =
  'Cash management needs the cash-up right. Ask a manager â€” they can do it under their own PIN.'

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
   * Tender identities for the count screen â€” deliberately WITHOUT expected
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

  const operator = await withTillOperator(ctx)
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
    // Identities only â€” the figures stay on the server.
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

  const operator = await withTillOperator(ctx)
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

  const operator = await withTillOperator(ctx)
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

  const operator = await withTillOperator(ctx)
  if (!can(operator.capabilities, 'sales.cashup')) return { ok: false, error: NEEDS_CASHUP }

  return closeShift(siteId, operator.actor, shiftId, counted, varianceNote)
}

/* ── The detailed declaration, at the till ─────────────────────────────────── */

/**
 * The full cash-up — denominations, every tender, banking — from the POS.
 *
 * ── WHY THESE ARE NOT THE BACK OFFICE'S ACTIONS ─────────────────────────────
 *
 * `declarationActions.ts` computes exactly the same view from exactly the same
 * engine, and these deliberately reuse both — `declarationView`, `visibleFor`,
 * `saveDeclaration` and `finalizeDeclaration` are imported, not reimplemented,
 * so the till and the back office can never sign off different arithmetic for
 * one shift.
 *
 * What cannot be shared is the GATE. Those actions resolve the BROWSER session;
 * at a till that is whoever unlocked the machine at seven in the morning, and a
 * cashier counting their own drawer would either be refused (no back-office
 * login) or, worse, allowed under the manager's rights. So each of these takes
 * the same `sales.till` + `withTillOperator` + `sales.cashup` path as every
 * other action in this file: the person holding the PIN is the person signing.
 *
 * ── THE COUNT IS STILL BLIND ────────────────────────────────────────────────
 *
 * `visibleFor` does the stripping, on the server, exactly as it does for the
 * back office. A tender's expected figure is withheld from the payload until a
 * number has been committed for it — which is why `tillRevealTenderAction`
 * exists rather than the modal simply reading the view.
 */

/** Resolves the till operator and confirms they may cash up. */
async function cashupOperator(): Promise<
  | { siteId: number; actor: { userId: number; userName: string }; capabilities: CapabilitySet }
  | Denied
> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx

  const operator = await withTillOperator(ctx)
  if (!can(operator.capabilities, 'sales.cashup')) return { ok: false, error: NEEDS_CASHUP }
  return operator
}

export async function tillDeclarationViewAction(
  shiftId: number,
): Promise<VisibleDeclaration | Denied> {
  const ctx = await cashupOperator()
  if ('ok' in ctx) return ctx

  const view = await declarationView(ctx.siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }
  return visibleFor(view)
}

/**
 * Who may be named as the supervisor witnessing the count.
 *
 * Active users, same as the back office. The till operator is usually NOT on
 * this list in spirit — the point of naming a supervisor is that a second
 * person watched the drawer being counted — but filtering them out here would
 * be wrong for a one-person shop where the owner is both.
 */
export async function tillSupervisorsAction(): Promise<
  { id: number; name: string }[] | Denied
> {
  const ctx = await cashupOperator()
  if ('ok' in ctx) return ctx

  const users = await listUsers(ctx.siteId)
  return users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))
}

/**
 * Commits one tender's count and returns its expected figure in exchange.
 *
 * The declared figure is PERSISTED, not merely echoed — otherwise a cashier
 * could read every expected figure by typing a number and discarding it, which
 * is precisely the copying the blind count exists to prevent. `denominations`
 * travels with it for the reason the back office learned the hard way: this
 * saves the whole declaration, so a grid typed but not yet saved would be
 * wiped, and a counted drawer would sign off with declared_cash of 0.00.
 */
export async function tillRevealTenderAction(
  shiftId: number,
  tenderTypeId: number,
  declared: number,
  denominations: Record<number, number>,
): Promise<
  { ok: true; expected: number; floatIncluded: number; variance: number } | Denied
> {
  const ctx = await cashupOperator()
  if ('ok' in ctx) return ctx

  const view = await declarationView(ctx.siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }
  if (view.finalizedAt) return { ok: false, error: 'This cash-up has been signed off.' }

  const tender = view.tenders.find((t) => t.tenderTypeId === tenderTypeId)
  if (!tender) return { ok: false, error: 'That tender is not on this shift.' }

  const saved = await saveDeclaration(ctx.siteId, ctx.actor, shiftId, {
    supervisorId: null,
    supervisorName: view.supervisorName,
    denominations,
    tenders: {
      ...Object.fromEntries(
        view.tenders.filter((t) => t.declared !== null).map((t) => [t.tenderTypeId, t.declared!]),
      ),
      [tenderTypeId]: declared,
    },
    bankDeclared: view.bankDeclared,
    bankReference: view.bankReference,
    varianceNote: view.varianceNote,
    note: view.note,
  })
  if (!saved.ok) return saved

  return {
    ok: true,
    expected: tender.expected,
    floatIncluded: tender.floatIncluded,
    variance: Math.round((declared - tender.expected) * 100) / 100,
  }
}

export async function tillSaveDeclarationAction(
  shiftId: number,
  input: DeclarationInput,
): Promise<{ ok: true; message: string } | Denied> {
  const ctx = await cashupOperator()
  if ('ok' in ctx) return ctx

  const result = await saveDeclaration(ctx.siteId, ctx.actor, shiftId, input)
  if (!result.ok) return result
  return { ok: true, message: 'Count saved.' }
}

/**
 * Signs the cash-up off and closes the shift.
 *
 * `finalizeDeclaration` delegates the close to `closeShift`, so the tolerance
 * rule, the frozen totals and the GL mirror are the same ones the quick count
 * on this very modal has always used.
 */
export async function tillFinalizeDeclarationAction(
  shiftId: number,
  input: DeclarationInput,
): Promise<{ ok: true; variance: number; withinTolerance: boolean } | Denied> {
  const ctx = await cashupOperator()
  if ('ok' in ctx) return ctx

  return finalizeDeclaration(ctx.siteId, ctx.actor, shiftId, input)
}

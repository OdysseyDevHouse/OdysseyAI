'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listUsers } from '@/lib/site/users'
import {
  declarationView,
  saveDeclaration,
  finalizeDeclaration,
  notePrint,
  type DeclarationInput,
} from '@/lib/site/cashupDeclaration'
import { visibleFor, type VisibleDeclaration } from './[shiftId]/declare/visible'

/**
 * The detailed cash-up, from the back office.
 *
 * Thin wrappers over cashupDeclaration.ts — the arithmetic, the freeze and the
 * refusals all live there. What this file adds is GATING: every entry point
 * re-checks `sales.cashup`, because a hidden button is not a boundary.
 *
 * The payload the browser gets is shaped by ./[shiftId]/declare/visible.ts,
 * which the page and these actions share so the two cannot disagree about it.
 */

export type DeclarationResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

export async function declarationViewAction(
  shiftId: number,
): Promise<VisibleDeclaration | { ok: false; error: string }> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx

  const view = await declarationView(ctx.siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }
  /* Blind unless this person may see the targets. Decided from THEIR
     capabilities, not from which screen asked — see visible.ts. */
  return visibleFor(view, !can(ctx.capabilities, 'sales.cashup_expected'))
}

/**
 * Persists ONE tender's declared figure, mid-count.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A drawer count takes real minutes and gets interrupted. Saving each tender as
 * it is entered means a browser that dies half way through loses nothing that
 * was already counted, rather than the whole declaration.
 *
 * It used to do a second job: hand back the expected figure the screen was not
 * otherwise allowed to know, in exchange for a committed count. Expected
 * figures now ship with the page, so the reconciliation is worked out in the
 * browser as somebody types and this call is purely about durability. It still
 * returns the tender's figures so a caller can reconcile against the SAVED
 * state rather than what is on screen.
 */
export async function saveTenderAction(
  shiftId: number,
  tenderTypeId: number,
  declared: number,
  /**
   * The grid AS TYPED, which the server has not been told about yet.
   *
   * Load-bearing. Committing a tender saves the whole declaration, so carrying
   * the server's copy forward instead would wipe a denomination count somebody
   * had typed but not yet saved — which is exactly what happened the first time
   * this shipped: a counted drawer signed off with declared_cash of 0.00.
   */
  denominations: Record<number, number>,
): Promise<
  | { ok: true; expected: number; floatIncluded: number; variance: number }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx

  const view = await declarationView(ctx.siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }
  if (view.finalizedAt) {
    return { ok: false, error: 'This cash-up has been signed off.' }
  }

  const tender = view.tenders.find((t) => t.tenderTypeId === tenderTypeId)
  if (!tender) return { ok: false, error: 'That tender is not on this shift.' }

  const saved = await saveDeclaration(ctx.siteId, ctx.actor, shiftId, {
    supervisorId: null,
    supervisorName: view.supervisorName,
    /* Carried through unchanged — see the note in the till's own action. */
    smallChange: view.smallChange,
    // What is on the SCREEN, not what was last saved. See the parameter's note.
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

/** Who can be named as supervisor. Active back-office users only. */
export async function supervisorsAction(): Promise<
  { id: number; name: string }[] | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const users = await listUsers(ctx.siteId)
  return users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }))
}

export async function saveDeclarationAction(
  shiftId: number,
  input: DeclarationInput,
): Promise<DeclarationResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx

  const result = await saveDeclaration(ctx.siteId, ctx.actor, shiftId, input)
  if (!result.ok) return result

  revalidatePath('/sales/cashup')
  return { ok: true, message: 'Count saved.' }
}

/**
 * Records that the declaration was pre-printed.
 *
 * Saves first, so the printed sheet matches what is stored rather than whatever
 * was last committed — a pre-print that disagrees with the draft is worse than
 * no pre-print, because somebody will check the drawer against it.
 */
export async function prePrintAction(
  shiftId: number,
  input: DeclarationInput,
): Promise<DeclarationResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx

  const saved = await saveDeclaration(ctx.siteId, ctx.actor, shiftId, input)
  if (!saved.ok) return saved

  await notePrint(ctx.siteId, shiftId)
  revalidatePath('/sales/cashup')
  return { ok: true, message: 'Count saved and marked as printed.' }
}

export async function finalizeDeclarationAction(
  shiftId: number,
  input: DeclarationInput,
): Promise<DeclarationResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx

  const result = await finalizeDeclaration(ctx.siteId, ctx.actor, shiftId, input)
  if (!result.ok) return result

  revalidatePath('/sales/cashup')
  return {
    ok: true,
    message:
      result.variance === 0
        ? 'Cashed up exactly.'
        : `Cashed up ${result.variance < 0 ? 'short' : 'over'} by ${Math.abs(result.variance).toFixed(2)}.`,
  }
}

'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { listUsers } from '@/lib/site/users'
import {
  tipsOwed,
  tipsEarned,
  listPayouts,
  payTipsOut,
  splitPoolOut,
  outstandingTipsFor,
  type PayoutMethod,
  type PoolShare,
  type TipsOwed,
  type TipPayout,
} from '@/lib/site/tips'

/**
 * Paying tips out.
 *
 * ── WHY sales.cashup AND NOT setup.edit ───────────────────────────────────
 *
 * Setup → Tips decides what a shop CHARGES, which is configuration a waiter must not touch
 * mid-service. Handing the money over is the other thing entirely: it happens at the end of
 * a shift, by whoever counts the drawer, and it is the same trust as closing that drawer.
 * So it sits with the cash-up, not with the configuration.
 *
 * Every mutation returns the whole fresh state, like the tier editor and the quick-key
 * designer: the server decides what is still outstanding, and a client holding its own guess
 * would offer to pay money that has just been paid.
 */

export type TipsState = {
  owed: TipsOwed[]
  earned: TipsOwed[]
  payouts: TipPayout[]
  staff: { id: number; name: string }[]
}

export type TipsResult = { ok: true; state: TipsState } | { ok: false; error: string }

type Range = { from: string; to: string }

/**
 * A date range that cannot silently mean "everything".
 *
 * A blank or malformed date reaching a BETWEEN clause matches nothing or matches everything
 * depending on the driver, and the second one would offer to pay out the shop's entire
 * history in one envelope.
 */
function cleanRange(range: Range): Range | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (!iso.test(range.from) || !iso.test(range.to)) return null
  return range.from <= range.to ? range : { from: range.to, to: range.from }
}

async function state(siteId: number, range: Range): Promise<TipsState> {
  const [owed, earned, payouts, users] = await Promise.all([
    tipsOwed(siteId, range),
    tipsEarned(siteId, range),
    listPayouts(siteId, range),
    listUsers(siteId),
  ])
  return {
    owed,
    earned,
    payouts,
    /* Only ACTIVE staff can receive a share. A pool split is a decision about who is working
       now, and a list including everybody who ever worked here makes the wrong name one
       mis-tap away. Somebody already paid keeps their payout row either way. */
    staff: users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name })),
  }
}

export async function loadTipsAction(range: Range): Promise<TipsResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const clean = cleanRange(range)
  if (!clean) return { ok: false, error: 'Choose a from and to date.' }
  return { ok: true, state: await state(siteId, clean) }
}

/** The individual tips behind one person's total — what is actually in the envelope. */
export async function tipDetailAction(
  userId: number | null,
  range: Range,
): Promise<
  | { ok: true; tips: Awaited<ReturnType<typeof outstandingTipsFor>> }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const clean = cleanRange(range)
  if (!clean) return { ok: false, error: 'Choose a from and to date.' }
  return { ok: true, tips: await outstandingTipsFor(siteId, userId, clean) }
}

export async function payOutAction(input: {
  userId: number | null
  userName: string
  range: Range
  method: PayoutMethod
  note?: string
}): Promise<TipsResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const clean = cleanRange(input.range)
  if (!clean) return { ok: false, error: 'Choose a from and to date.' }

  const paid = await payTipsOut(siteId, actor, { ...input, range: clean })
  if (!paid.ok) return { ok: false, error: paid.error }

  revalidatePath('/sales/tips')
  return { ok: true, state: await state(siteId, clean) }
}

export async function splitPoolAction(input: {
  range: Range
  method: PayoutMethod
  shares: PoolShare[]
  note?: string
}): Promise<TipsResult> {
  const ctx = await actorFor('sales.cashup')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const clean = cleanRange(input.range)
  if (!clean) return { ok: false, error: 'Choose a from and to date.' }

  const split = await splitPoolOut(siteId, actor, { ...input, range: clean })
  if (!split.ok) return { ok: false, error: split.error }

  revalidatePath('/sales/tips')
  return { ok: true, state: await state(siteId, clean) }
}

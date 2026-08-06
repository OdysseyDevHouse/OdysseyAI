'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import { lockPeriod, unlockPeriod, lockMonth, type LockScope, type LockType } from '@/lib/site/periodLocks'
import {
  requestWriteOff,
  approveWriteOff,
  rejectWriteOff,
  recoverWriteOff,
  type WriteOffCategory,
} from '@/lib/site/writeOffs'
import { proposeRun, postRun, cancelRun, excludeItem } from '@/lib/site/interestRuns'
import { allocate, autoAllocate } from '@/lib/site/customerLedger'

/**
 * Accounting actions — period locks, write-offs, interest runs, allocation.
 *
 * Everything here either moves money or decides what may move it. They return
 * their result rather than redirecting so the screen can report the outcome in
 * a toast without losing the user's place in a long list.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

/* ── Period locks ────────────────────────────────────────────────────────── */

export async function lockPeriodAction(input: {
  periodFrom: string
  periodTo: string
  lockType?: LockType
  scope?: LockScope
  reason?: string
}): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await lockPeriod(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/accounting/periods')
  return { ok: true, message: 'Period closed.' }
}

export async function lockMonthAction(
  year: number,
  month: number,
  opts: { lockType?: LockType; scope?: LockScope; reason?: string } = {},
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await lockMonth(siteId, actor, year, month, opts)
  if (!result.ok) return result

  revalidatePath('/accounting/periods')
  return { ok: true, message: 'Month closed.' }
}

export async function unlockPeriodAction(id: number, reason: string): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await unlockPeriod(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidatePath('/accounting/periods')
  return { ok: true, message: 'Period reopened.' }
}

/* ── Write-offs ──────────────────────────────────────────────────────────── */

export async function requestWriteOffAction(input: {
  customerId: number
  amount: number
  reason: string
  category?: WriteOffCategory
  writeOffDate?: string
  approvalThreshold?: number
}): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await requestWriteOff(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/accounting/write-offs')
  revalidatePath(`/customers/${input.customerId}`)

  return {
    ok: true,
    message:
      result.status === 'posted'
        ? 'Written off.'
        : 'Requested — it needs approval before the balance moves.',
  }
}

export async function approveWriteOffAction(id: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await approveWriteOff(siteId, actor, id)
  if (!result.ok) return result

  revalidatePath('/accounting/write-offs')
  return { ok: true, message: 'Approved and written off.' }
}

export async function rejectWriteOffAction(id: number, reason: string): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await rejectWriteOff(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidatePath('/accounting/write-offs')
  return { ok: true, message: 'Rejected.' }
}

export async function recoverWriteOffAction(id: number, amount?: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await recoverWriteOff(siteId, actor, id, amount)
  if (!result.ok) return result

  revalidatePath('/accounting/write-offs')
  return { ok: true, message: 'Recovered — the debt is back on the account.' }
}

/* ── Interest ────────────────────────────────────────────────────────────── */

export async function proposeInterestRunAction(input: {
  periodFrom: string
  periodTo: string
  asAtDate?: string
  minimumCharge?: number
  notes?: string
}): Promise<ActionResult & { runId?: number }> {
  const { siteId, actor } = await requireActor()

  const result = await proposeRun(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/accounting/interest')
  return {
    ok: true,
    runId: result.runId,
    message: `${result.charged} account${result.charged === 1 ? '' : 's'} would be charged ${result.total.toFixed(2)}. Nothing has been posted yet.`,
  }
}

export async function postInterestRunAction(runId: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await postRun(siteId, actor, runId)
  if (!result.ok) return result

  revalidatePath('/accounting/interest')
  return {
    ok: true,
    message: `Charged ${result.posted} account${result.posted === 1 ? '' : 's'}, ${result.total.toFixed(2)} total.`,
  }
}

export async function cancelInterestRunAction(runId: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await cancelRun(siteId, actor, runId)
  if (!result.ok) return result

  revalidatePath('/accounting/interest')
  return { ok: true, message: 'Run cancelled.' }
}

export async function excludeInterestItemAction(
  itemId: number,
  reason: string,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await excludeItem(siteId, actor, itemId, reason)
  if (!result.ok) return result

  revalidatePath('/accounting/interest')
  return { ok: true, message: 'Account excluded from this run.' }
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

export async function autoAllocateAction(creditTxnId: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await autoAllocate(siteId, actor, creditTxnId)
  if (!result.ok) return result

  revalidatePath('/accounting/unallocated')
  return {
    ok: true,
    message:
      result.allocated > 0
        ? `Applied ${result.allocated.toFixed(2)} against the oldest invoices.`
        : 'There was nothing open to apply it to.',
  }
}

export async function allocateAction(
  debitTxnId: number,
  creditTxnId: number,
  amount: number,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await allocate(siteId, actor, debitTxnId, creditTxnId, amount)
  if (!result.ok) return result

  revalidatePath('/accounting/unallocated')
  return { ok: true, message: `Applied ${result.allocated.toFixed(2)}.` }
}

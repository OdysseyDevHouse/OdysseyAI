'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { createRule, updateRule, deleteRule, type RuleInput } from '@/lib/site/commission'
import {
  createRun,
  calculateRun,
  lockRun,
  unlockRun,
} from '@/lib/site/commissionRuns'

/**
 * Every action re-checks its capability rather than trusting the screen that
 * offered the button. A server action is a public endpoint, and commission is
 * the one place in this app where a missing check is worth actual money.
 */
async function needs(capability: Capability) {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, capability)) return null
  return ctx
}

type Result = { ok: true; message: string } | { ok: false; error: string }

const DENIED = { ok: false as const, error: 'You do not have permission to do that.' }

export async function saveRuleAction(
  ruleId: number | null,
  input: RuleInput,
): Promise<{ ok: true; id: number; message: string } | { ok: false; error: string }> {
  const ctx = await needs('commission.edit')
  if (!ctx) return DENIED

  const result = ruleId
    ? await updateRule(ctx.site.id, ruleId, input)
    : await createRule(ctx.site.id, input)
  if (!result.ok) return result

  revalidatePath('/commission/rules')
  return {
    ok: true,
    id: result.id,
    message: ruleId ? 'Rule saved.' : `“${input.name.trim()}” created.`,
  }
}

export async function deleteRuleAction(ruleId: number): Promise<Result> {
  const ctx = await needs('commission.edit')
  if (!ctx) return DENIED

  await deleteRule(ctx.site.id, ruleId)
  revalidatePath('/commission/rules')
  // Locked runs keep their own snapshot of the rule's name, basis and rate, so
  // deleting it here cannot rewrite what anybody was already paid.
  return { ok: true, message: 'Rule deleted. Locked runs keep the figures they were calculated with.' }
}

export async function createRunAction(
  periodStart: string,
  periodEnd: string,
  note: string,
): Promise<{ ok: true; id: number; message: string } | { ok: false; error: string }> {
  const ctx = await needs('commission.run')
  if (!ctx) return DENIED

  const result = await createRun(ctx.site.id, periodStart, periodEnd, note)
  if (!result.ok) return result

  revalidatePath('/commission')
  return { ok: true, id: result.id, message: 'Period opened.' }
}

export async function calculateRunAction(runId: number): Promise<Result> {
  const ctx = await needs('commission.run')
  if (!ctx) return DENIED

  const result = await calculateRun(ctx.site.id, runId)
  if (!result.ok) return result

  revalidatePath('/commission')
  revalidatePath(`/commission/${runId}`)
  return {
    ok: true,
    message: result.entries
      ? `${result.entries} line${result.entries === 1 ? '' : 's'} for ${result.people} ${result.people === 1 ? 'person' : 'people'} — R ${result.total.toFixed(2)}.`
      : 'Nothing earned commission in this period.',
  }
}

export async function lockRunAction(runId: number): Promise<Result> {
  const ctx = await needs('commission.run')
  if (!ctx) return DENIED

  const result = await lockRun(ctx.site.id, runId, {
    userId: ctx.user.id,
    userName: ctx.user.name,
  })
  if (!result.ok) return result

  revalidatePath('/commission')
  revalidatePath(`/commission/${runId}`)
  return { ok: true, message: 'Locked. These figures will not change again.' }
}

export async function unlockRunAction(runId: number): Promise<Result> {
  const ctx = await needs('commission.run')
  if (!ctx) return DENIED

  const result = await unlockRun(ctx.site.id, runId)
  if (!result.ok) return result

  revalidatePath('/commission')
  revalidatePath(`/commission/${runId}`)
  return { ok: true, message: 'Reopened. Recalculate before locking it again.' }
}

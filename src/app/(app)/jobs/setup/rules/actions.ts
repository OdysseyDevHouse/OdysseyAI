'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import {
  saveRule,
  deleteRule,
  type RuleInput,
  type RuleResult,
  type RuleActionResult,
} from '@/lib/site/jobRules'

/**
 * Editing the rules.
 *
 * Gated on `jobs.setup`, the same capability that guards statuses, boards and
 * forms: a rule decides how the business runs a job, which is configuration
 * rather than work. Somebody with `jobs.edit` moves jobs; somebody with
 * `jobs.setup` decides what moves them on its own.
 *
 * That distinction matters more here than on the other setup screens. A rule
 * acts with nobody watching, and every action it takes is attributed to the
 * person the event happened to — so the ability to write one is the ability to
 * make things happen under other people's names.
 */

function refresh() {
  revalidatePath('/jobs/setup/rules')
  // A rule change alters what happens on every open job.
  revalidatePath('/jobs')
}

export async function saveRuleAction(input: RuleInput): Promise<RuleResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await saveRule(ctx.siteId, ctx.actor, input)
  if (result.ok) refresh()
  return result
}

export async function deleteRuleAction(id: number): Promise<RuleActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  const result = await deleteRule(ctx.siteId, ctx.actor, id)
  if (result.ok) refresh()
  return result
}

/**
 * How long before the same rule may fire again on the same job.
 *
 * Editable from this screen because it is the one number that changes what
 * every rule does, and somebody debugging a rule they just wrote is exactly who
 * needs to turn it down. The depth cap is NOT editable and still applies, so
 * even at zero the machine cannot spin.
 */
export async function setCooldownAction(minutes: number): Promise<RuleActionResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx

  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
    return { ok: false, error: 'Give a number of minutes between 0 and 1440.' }
  }

  await setSetting(ctx.siteId, 'job_rule_cooldown_minutes', String(Math.round(minutes)))
  refresh()
  return { ok: true }
}

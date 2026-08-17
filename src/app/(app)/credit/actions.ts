'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { send, isConfigured } from '@/lib/mail'
import { getSmsProvider } from '@/lib/site/sms'
import {
  buildRun,
  processRun,
  cancelRun,
  excludeItem,
  saveLevel,
  deleteLevel,
  createPromise,
  resolvePromise,
  sweepPromises,
  logContact,
  pauseChasing,
  resumeChasing,
  holdAccount,
  releaseAccount,
  type ContactKind,
  type ContactOutcome,
} from '@/lib/site/creditControl'

/**
 * Credit control actions.
 *
 * ── THE CAPABILITY SPLIT ─────────────────────────────────────────────────
 *
 * Reading the collections list and logging a call is `customers.view` work —
 * whoever is on the phone needs it. Releasing a run, holding an account, or
 * rewriting the ladder is `customers.credit`, because each of those either
 * sends something a customer will read or stops them buying.
 *
 * Every one of these guards for itself. A hidden button is not a boundary.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

/* ── Runs ────────────────────────────────────────────────────────────────── */

export async function buildRunAction(input: {
  asAt?: string
  customerIds?: number[]
}): Promise<ActionResult & { runId?: number }> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await buildRun(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath('/credit/runs')
  return {
    ok: true,
    runId: result.runId,
    message:
      result.queued === 0
        ? `Nothing to send — ${result.skipped} account${result.skipped === 1 ? '' : 's'} skipped.`
        : `${result.queued} letter${result.queued === 1 ? '' : 's'} ready to review.`,
  }
}

/**
 * Release a run — the point at which customers actually hear from us.
 *
 * Checks that email is configured BEFORE marking anything sending. A run that
 * flips to 'sending' and then fails every item on missing SMTP looks like two
 * hundred bounced addresses rather than one missing setting.
 */
export async function releaseRunAction(runId: number): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  if (!isConfigured()) {
    return { ok: false, error: 'Email is not set up yet. Add SMTP details in Setup first.' }
  }

  // The SMS leg rides along when a provider is configured; absent, levels
  // that text record their leg as skipped rather than failing the run.
  const smsProvider = await getSmsProvider(siteId)

  const result = await processRun(siteId, runId, actor, {
    companyName: await companyName(siteId),
    send: async (input) => {
      const outcome = await send(input)
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
    },
    ...(smsProvider
      ? {
          sendSms: async (to: string, body: string) => {
            const outcome = await smsProvider.send(to, body)
            return outcome.ok ? { ok: true as const } : { ok: false as const, error: outcome.error }
          },
        }
      : {}),
  })

  revalidatePath('/credit')
  revalidatePath(`/credit/runs/${runId}`)

  if (result.sent === 0 && result.failed === 0) {
    return { ok: false, error: 'There was nothing left to send in that run.' }
  }
  return {
    ok: true,
    message:
      result.failed === 0
        ? `${result.sent} reminder${result.sent === 1 ? '' : 's'} sent.`
        : `${result.sent} sent, ${result.failed} failed.`,
  }
}

export async function cancelRunAction(runId: number): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  const result = await cancelRun(ctx.siteId, ctx.actor, runId)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath(`/credit/runs/${runId}`)
  return { ok: true, message: 'Run cancelled. Nothing was sent.' }
}

export async function excludeItemAction(itemId: number, reason: string): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  const result = await excludeItem(ctx.siteId, ctx.actor, itemId, reason)
  if (!result.ok) return result

  revalidatePath('/credit')
  return { ok: true, message: 'Removed from this run.' }
}

/* ── The ladder ──────────────────────────────────────────────────────────── */

export async function saveLevelAction(
  id: number | null,
  input: {
    step: number
    name: string
    minDaysOverdue: number
    minAmount: number
    subject: string
    body: string
    channel: 'email' | 'sms' | 'both'
    smsBody: string
    blocksAccount: boolean
    requiresCall: boolean
    isActive: boolean
  },
): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  const result = await saveLevel(ctx.siteId, ctx.actor, id, {
    ...input,
    channel: ['email', 'sms', 'both'].includes(input.channel) ? input.channel : 'email',
    smsBody: input.smsBody.trim() || null,
  })
  if (!result.ok) return result

  revalidatePath('/credit/levels')
  return { ok: true, message: id ? 'Level saved.' : 'Level added.' }
}

export async function deleteLevelAction(id: number): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  const result = await deleteLevel(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result

  revalidatePath('/credit/levels')
  return { ok: true, message: 'Level deleted.' }
}

/* ── Promises ────────────────────────────────────────────────────────────── */

export async function createPromiseAction(input: {
  customerId: number
  promisedDate: string
  promisedAmount: number
  promisedBy?: string
  notes?: string
}): Promise<ActionResult> {
  // Whoever is on the phone records the promise. Deliberately not gated behind
  // customers.credit: a promise the collector cannot write down is a promise
  // that gets lost, which is the exact failure this module exists to fix.
  const ctx = await actorForModule('customers', 'customers.view')
  if ('ok' in ctx) return ctx

  const result = await createPromise(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath('/credit/promises')
  revalidatePath(`/customers/${input.customerId}`)
  return { ok: true, message: 'Promise recorded.' }
}

export async function resolvePromiseAction(
  promiseId: number,
  outcome: 'kept' | 'broken' | 'cancelled',
  receivedAmount?: number,
): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.view')
  if ('ok' in ctx) return ctx

  const result = await resolvePromise(ctx.siteId, ctx.actor, promiseId, outcome, receivedAmount)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath('/credit/promises')
  return {
    ok: true,
    message:
      outcome === 'kept'
        ? 'Marked as kept.'
        : outcome === 'broken'
          ? 'Marked as broken.'
          : 'Promise cancelled.',
  }
}

export async function sweepPromisesAction(): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.view')
  if ('ok' in ctx) return ctx

  const broken = await sweepPromises(ctx.siteId, ctx.actor)
  revalidatePath('/credit/promises')
  return {
    ok: true,
    message:
      broken === 0
        ? 'No promises have been broken.'
        : `${broken} promise${broken === 1 ? '' : 's'} marked broken.`,
  }
}

/* ── Contact log ─────────────────────────────────────────────────────────── */

export async function logContactAction(input: {
  customerId: number
  kind: ContactKind
  outcome: ContactOutcome
  summary: string
  detail?: string
  contactDate?: string
}): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.view')
  if ('ok' in ctx) return ctx

  const result = await logContact(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath(`/customers/${input.customerId}`)
  return { ok: true, message: 'Logged.' }
}

/* ── Account state ───────────────────────────────────────────────────────── */

export async function pauseChasingAction(
  customerId: number,
  until: string,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  const result = await pauseChasing(ctx.siteId, ctx.actor, customerId, until, reason)
  if (!result.ok) return result

  revalidatePath('/credit')
  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: `Chasing paused until ${until}.` }
}

export async function resumeChasingAction(customerId: number): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  await resumeChasing(ctx.siteId, ctx.actor, customerId)
  revalidatePath('/credit')
  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Chasing resumed.' }
}

export async function holdAccountAction(
  customerId: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx
  if (!reason.trim()) return { ok: false, error: 'Say why the account is being held.' }

  await holdAccount(ctx.siteId, ctx.actor, customerId, reason)
  revalidatePath('/credit')
  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Account placed on hold.' }
}

export async function releaseAccountAction(
  customerId: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('customers', 'customers.credit')
  if ('ok' in ctx) return ctx

  await releaseAccount(ctx.siteId, ctx.actor, customerId, reason)
  revalidatePath('/credit')
  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Credit restored.' }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * The name letters are signed with.
 *
 * The trading name where there is one — that is what a customer recognises on
 * an invoice, and a reminder signed with a registered entity nobody has heard
 * of reads like a scam.
 */
async function companyName(siteId: number): Promise<string> {
  const { publicSiteName } = await import('@/lib/sites')
  return (await publicSiteName(siteId)) ?? 'Accounts'
}

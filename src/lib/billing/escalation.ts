import 'server-only'
import { round } from '@/lib/decimals'
import {
  dueForEscalation,
  markEscalated,
  markSynced,
  needingSync,
  subscriptionForAccount,
} from '@/lib/control/subscriptions'
import { quoteForAccount } from './accountQuote'
import { platformPayFast, platformPayFastStatus } from '@/lib/payfast/platformConfig'
import { updateSubscriptionAmount } from '@/lib/payfast/api'

/**
 * The annual increase, and the sweep that keeps PayFast agreeing with us.
 *
 * ── WHY THIS RUNS DAILY RATHER THAN ANNUALLY ───────────────────────────────
 *
 * Each account escalates on its OWN anniversary, so the job has to look every
 * day and act on the few that are due. The previous system ran once a year and
 * escalated everybody on whatever day that happened to be — a customer who
 * signed up in November got their first increase in February.
 *
 * ── AND WHY RUNNING IT TWICE IS SAFE ───────────────────────────────────────
 *
 * `markEscalated` carries the year guard in the WHERE of its own UPDATE, so a
 * second run the same day — or a second run in December after one in March —
 * matches zero rows. That matters more than it sounds: the old job applied the
 * increase again on every run, and compounding a price rise by accident is a
 * real overcharge somebody has to be refunded for.
 */

export type EscalationResult = {
  considered: number
  escalated: number
  pushed: number
  /** Raised locally but not yet accepted by PayFast; reconciliation retries. */
  unsynced: number
  failures: { accountId: number; error: string }[]
}

/**
 * Raise the price for every account whose anniversary is today.
 *
 * ── LOCAL FIRST, THEN PAYFAST ──────────────────────────────────────────────
 *
 * The claim and the new amount are committed before the gateway is called. The
 * other order — push, then persist — loses the FACT of the escalation if the
 * process dies between the two, and the next run then raises a price PayFast
 * has already raised. A lagging sync is a report; a double increase is money
 * taken that was never agreed.
 */
export async function runEscalation(
  today: string,
  deps: { push?: typeof updateSubscriptionAmount } = {},
): Promise<EscalationResult> {
  const due = await dueForEscalation(today)
  const result: EscalationResult = {
    considered: due.length,
    escalated: 0,
    pushed: 0,
    unsynced: 0,
    failures: [],
  }

  const configured = platformPayFastStatus()
  const push = deps.push ?? updateSubscriptionAmount

  for (const sub of due) {
    const next = round(sub.amountIncl * (1 + sub.escalationPercent / 100), 2)
    if (next === sub.amountIncl) continue

    // Claims the year. False means another worker got there first.
    const claimed = await markEscalated(sub.id, next, today)
    if (!claimed) continue
    result.escalated++

    if (!configured.ok || !sub.pfToken) {
      result.unsynced++
      continue
    }

    const pushed = await push(platformPayFast(), sub.pfToken, next)
    if (pushed.ok) {
      await markSynced(sub.accountId)
      result.pushed++
    } else {
      /* Left for reconciliation rather than retried here. `markEscalated`
         already cleared synced_at, so the sweep below finds it. */
      result.unsynced++
      result.failures.push({ accountId: sub.accountId, error: pushed.error })
      console.error('[payfast-sub] escalated locally but could not push', {
        accountId: sub.accountId,
        amount: next,
        error: pushed.error,
      })
    }
  }

  return result
}

export type ReconcileResult = {
  considered: number
  pushed: number
  failures: { accountId: number; error: string }[]
}

/**
 * Make PayFast agree with the local price.
 *
 * Picks up everything whose `synced_at` is null — a plan change whose push
 * failed, an escalation the gateway refused, anything at all that left the two
 * disagreeing. Idempotent by construction: PATCHing an amount that is already
 * correct is a no-op, so this can run as often as it likes.
 *
 * It re-derives the amount rather than trusting the stored one, so an account
 * whose modules changed while the gateway was unreachable converges on what it
 * should actually be paying rather than on a figure that was already stale.
 */
export async function runReconciliation(
  deps: { push?: typeof updateSubscriptionAmount } = {},
): Promise<ReconcileResult> {
  const pending = await needingSync()
  const result: ReconcileResult = { considered: pending.length, pushed: 0, failures: [] }

  const configured = platformPayFastStatus()
  if (!configured.ok) return result

  const push = deps.push ?? updateSubscriptionAmount

  for (const sub of pending) {
    if (!sub.pfToken) continue

    const { total } = await quoteForAccount(sub.accountId)
    /* A plan that now comes to nothing is not pushed — a zero mandate collects
       nothing for ever and looks perfectly healthy. Left unsynced and visible. */
    if (!(total > 0)) continue

    const pushed = await push(platformPayFast(), sub.pfToken, total)
    if (pushed.ok) {
      await markSynced(sub.accountId)
      result.pushed++
    } else {
      result.failures.push({ accountId: sub.accountId, error: pushed.error })
    }
  }

  return result
}

/** What PayFast believes, for a screen that wants to show a discrepancy. */
export async function driftForAccount(
  accountId: number,
): Promise<{ local: number; synced: boolean } | null> {
  const sub = await subscriptionForAccount(accountId)
  if (!sub) return null
  return { local: sub.amountIncl, synced: sub.syncedAt !== null }
}

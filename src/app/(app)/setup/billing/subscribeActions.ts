'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireSession, type Denied } from '@/lib/auth'
import { accountForSite } from '@/lib/control/modules'
import {
  startCheckoutAttempt,
  subscriptionForAccount,
  setAmount,
  markSynced,
  markStatus,
} from '@/lib/control/subscriptions'
import { quoteForAccount } from '@/lib/billing/accountQuote'
import { platformPayFast, platformPayFastStatus } from '@/lib/payfast/platformConfig'
import { buildSubscriptionForm } from '@/lib/payfast/subscription'
import { createBillingCallbackToken } from '@/lib/billingCallbackToken'
import {
  updateSubscriptionAmount,
  cancelSubscription,
  pauseSubscription,
  unpauseSubscription,
} from '@/lib/payfast/api'
import { nextBillingDate, safeBillingDay } from '@/lib/billing/period'
import type { CheckoutForm } from '@/lib/payfast/checkout'

/**
 * Setting up, changing and stopping the debit order.
 *
 * Kept apart from `actions.ts` — which owns module toggles — because these
 * touch a third party and money, and because the two files are then rarely
 * edited in the same breath.
 */

/**
 * Hand the browser a signed PayFast form.
 *
 * ── IT TAKES NO ARGUMENTS, AND THAT IS THE SECURITY MODEL ──────────────────
 *
 * The client posts nothing: not an amount, not a plan, not a store list. Every
 * figure is re-derived from the database here. A client that cannot name a
 * number cannot name a wrong one, which is stronger than validating whatever
 * it sent.
 */
export async function startSubscriptionAction(): Promise<
  { ok: true; form: CheckoutForm; amount: number; firstCollection: string } | Denied
> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const configured = platformPayFastStatus()
  if (!configured.ok) {
    /* Refused with the actual reason rather than a generic failure. The most
       likely cause is a notify URL PayFast cannot reach, which otherwise
       presents as money arriving and nothing being recorded. */
    return {
      ok: false,
      error: `Card payments are not set up yet: ${configured.missing.join('; ')}`,
    }
  }

  const session = await requireSession()
  const account = await accountForSite(ctx.siteId)
  if (!account) return { ok: false, error: 'This store is not attached to a billing account yet.' }

  const { total } = await quoteForAccount(account.id)

  // Claims the attempt under a row lock — see startCheckoutAttempt for why.
  const attempt = await startCheckoutAttempt(account.id, total)
  if (!attempt.ok) return { ok: false, error: attempt.error }

  const config = platformPayFast()
  const token = await createBillingCallbackToken(account.id, attempt.reference)

  /* The first collection is the account's next billing day, so the customer's
     debit order lands on the day they already expect to be charged rather than
     on whichever day they happened to sign up. */
  const today = new Date().toISOString().slice(0, 10)
  const firstCollection = nextBillingDate(today, safeBillingDay(account.billingDay))

  const form = buildSubscriptionForm({
    config,
    reference: attempt.reference,
    amountIncl: attempt.amountIncl,
    billingDate: firstCollection,
    itemName: `Odyssey — ${account.name}`.slice(0, 100),
    itemDescription: 'Monthly platform subscription',
    notifyUrl: `${config.notifyUrl.replace(/\/$/, '')}/${token}`,
    buyerName: ctx.actor.userName,
    buyerEmail: account.billingEmail ?? session.email,
    accountId: account.id,
  })

  return { ok: true, form, amount: attempt.amountIncl, firstCollection }
}

/**
 * Push the current plan price to PayFast.
 *
 * ── LOCAL FIRST, PAYFAST SECOND, NEVER ROLLED BACK ─────────────────────────
 *
 * The customer bought the module and `addModule` granted it immediately, by
 * design. Undoing the price because a third-party HTTP call timed out would
 * either revoke a feature they were told they had, or leave the price right
 * and the entitlement wrong. Both are worse than a price we know is briefly
 * ahead of PayFast's.
 *
 * So a failure here is RECORDED, not reversed: `setAmount` clears `synced_at`,
 * and the reconciliation sweep retries. PATCHing an amount that is already
 * correct is a no-op, so retrying costs nothing.
 */
export async function syncSubscriptionAmount(
  accountId: number,
): Promise<{ ok: true; amount: number; pushed: boolean }> {
  const { total } = await quoteForAccount(accountId)
  await setAmount(accountId, total)

  const sub = await subscriptionForAccount(accountId)
  // Nothing to push at: no mandate, or one that is not collecting.
  if (!sub?.pfToken || (sub.status !== 'active' && sub.status !== 'past_due')) {
    return { ok: true, amount: total, pushed: false }
  }

  const status = platformPayFastStatus()
  if (!status.ok) return { ok: true, amount: total, pushed: false }

  const result = await updateSubscriptionAmount(platformPayFast(), sub.pfToken, total)
  if (!result.ok) {
    console.error('[payfast-sub] could not push the new amount; left for reconciliation', {
      accountId,
      amount: total,
      error: result.error,
    })
    return { ok: true, amount: total, pushed: false }
  }

  await markSynced(accountId)
  return { ok: true, amount: total, pushed: true }
}

/**
 * Stop the debit order.
 *
 * PayFast is told FIRST here, unlike the amount sync. Cancelling is the one
 * operation where believing it happened when it did not keeps taking money
 * from somebody who asked us to stop.
 */
export async function cancelSubscriptionAction(reason?: string): Promise<{ ok: true } | Denied> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const account = await accountForSite(ctx.siteId)
  if (!account) return { ok: false, error: 'This store is not attached to a billing account yet.' }

  const sub = await subscriptionForAccount(account.id)
  if (!sub?.pfToken) return { ok: false, error: 'There is no debit order to cancel.' }

  const result = await cancelSubscription(platformPayFast(), sub.pfToken)
  if (!result.ok) {
    return {
      ok: false,
      error: `PayFast could not cancel the debit order (${result.error}). Nothing has changed — please try again.`,
    }
  }

  await markStatus(account.id, 'cancelled', reason?.slice(0, 190))
  revalidatePath('/setup/billing')
  return { ok: true }
}

/** Skip one collection. Access is unaffected — that is a separate decision. */
export async function pauseSubscriptionAction(): Promise<{ ok: true } | Denied> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const account = await accountForSite(ctx.siteId)
  if (!account) return { ok: false, error: 'This store is not attached to a billing account yet.' }

  const sub = await subscriptionForAccount(account.id)
  if (!sub?.pfToken) return { ok: false, error: 'There is no debit order to pause.' }

  const result = await pauseSubscription(platformPayFast(), sub.pfToken, 1)
  if (!result.ok) return { ok: false, error: `PayFast could not pause it (${result.error}).` }

  await markStatus(account.id, 'paused')
  revalidatePath('/setup/billing')
  return { ok: true }
}

export async function resumeSubscriptionAction(): Promise<{ ok: true } | Denied> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const account = await accountForSite(ctx.siteId)
  if (!account) return { ok: false, error: 'This store is not attached to a billing account yet.' }

  const sub = await subscriptionForAccount(account.id)
  if (!sub?.pfToken) return { ok: false, error: 'There is no debit order to resume.' }

  const result = await unpauseSubscription(platformPayFast(), sub.pfToken)
  if (!result.ok) return { ok: false, error: `PayFast could not resume it (${result.error}).` }

  await markStatus(account.id, 'active')
  revalidatePath('/setup/billing')
  return { ok: true }
}

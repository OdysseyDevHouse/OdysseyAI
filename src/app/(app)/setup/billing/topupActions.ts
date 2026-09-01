'use server'

import { actorFor, requireSession, type Denied } from '@/lib/auth'
import { accountForSite } from '@/lib/control/modules'
import { platformPayFast, platformPayFastStatus } from '@/lib/payfast/platformConfig'
import { buildTopupForm } from '@/lib/payfast/topup'
import { createAiTopupToken } from '@/lib/aiTopupToken'
import { startTopup } from '@/lib/aiCredits/ledger'
import { isValidTopupAmount, localToMicros } from '@/lib/aiCredits/pricing'
import * as creditsPortal from '@/lib/aiCredits/creditsPortal'
import type { CheckoutForm } from '@/lib/payfast/checkout'

/**
 * Buying AI credits.
 *
 * Kept apart from subscribeActions.ts for the same reason that file is kept
 * apart from actions.ts: this is a once-off charge against a wallet, not the
 * monthly mandate, and the two should not be edited in the same breath.
 */

/**
 * Hand the browser a signed PayFast form for a top-up.
 *
 * ── THE AMOUNT IS CHECKED, NOT TRUSTED ─────────────────────────────────────
 *
 * startSubscriptionAction takes no arguments at all, because a subscription's
 * price is derivable — it is whatever the account's plan comes to. A top-up has
 * no such figure: the shop is choosing how much to buy, so the number has to
 * come from the client.
 *
 * So the rule here is the next best one. The client may only name an amount
 * from a list this server owns (./pricing's presets), and the amount that gets
 * SIGNED is the one this function looked up — not the one that arrived. A
 * tampered request is refused before anything is written, and a request that
 * somehow passed validation still could not smuggle a different figure into the
 * signature.
 *
 * The credit granted is fixed here too, converted once and stored on the
 * pending row, so a rate that moves before the notification lands cannot change
 * what was bought.
 */
export async function startTopupAction(
  amount: number,
): Promise<{ ok: true; form: CheckoutForm; amount: number } | Denied> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const configured = platformPayFastStatus()
  if (!configured.ok) {
    return {
      ok: false,
      error: `Card payments are not set up yet: ${configured.missing.join('; ')}`,
    }
  }

  const session = await requireSession()
  const account = await accountForSite(ctx.siteId)
  if (!account) return { ok: false, error: 'This store is not attached to a billing account yet.' }

  /* Whatever arrived is a claim. Only a preset for THIS account's currency
     survives, and `chosen` below is what gets signed. */
  const requested = Number(amount)
  if (!isValidTopupAmount(requested, account.currency)) {
    return { ok: false, error: 'Choose one of the listed top-up amounts.' }
  }
  const chosen = requested

  /* The pending row, from the portal on a desktop install and from SQL
     otherwise. Only the ROW moves: the form below is signed with the platform's
     merchant credentials, which stay on this server either way.

     The portal re-derives the credit from the amount and the account's
     currency, so `amountMicros` is not sent and cannot be chosen. A refusal is
     shown to the person; null falls through to the query. */
  const viaPortal = await creditsPortal.startTopup(chosen)
  if (viaPortal && !viaPortal.ok) return { ok: false, error: viaPortal.error }

  const amountMicros = localToMicros(chosen, account.currency)
  const reference =
    viaPortal?.ok
      ? viaPortal.intent.reference
      : await startTopup({
          accountId: account.id,
          siteId: ctx.siteId,
          amountMicros,
          amountPay: chosen,
          payCurrency: account.currency,
        })

  const config = platformPayFast()
  const token = createAiTopupToken(reference)

  const form = buildTopupForm({
    config,
    reference,
    amount: chosen,
    itemName: `Odyssey AI credits — ${account.name}`.slice(0, 100),
    itemDescription: 'AI credit top-up',
    notifyUrl: `${topupNotifyBase(config.notifyUrl)}/${token}`,
    buyerName: ctx.actor.userName,
    buyerEmail: account.billingEmail ?? session.email,
  })

  return { ok: true, form, amount: chosen }
}

/**
 * Where a top-up notification should land.
 *
 * ── WHY THIS IS NOT JUST config.notifyUrl ──────────────────────────────────
 *
 * PAYFAST_NOTIFY_URL points at /api/billing/payfast — the SUBSCRIPTION route.
 * Handing a top-up that URL would send its notification to the route that looks
 * up a subscription by account, finds one that is active or absent, and
 * acknowledges without crediting anything. Money taken, nothing delivered, and
 * a 200 telling PayFast never to try again.
 *
 * A second environment variable was the alternative and is worse: it can be
 * forgotten, and the failure it produces when forgotten is exactly the silent
 * one above. Deriving it from the configured URL means one value stays
 * authoritative for the host, the scheme and the tunnel, and the path is chosen
 * by the code that knows which route it wants.
 *
 * The trailing segment is replaced rather than appended so the two routes are
 * siblings, which is what they are.
 */
function topupNotifyBase(subscriptionNotifyUrl: string): string {
  const trimmed = subscriptionNotifyUrl.replace(/\/+$/, '')
  return `${trimmed.replace(/\/api\/billing\/payfast$/, '')}/api/billing/topup`
}

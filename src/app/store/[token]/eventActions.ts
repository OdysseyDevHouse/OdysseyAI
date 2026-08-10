'use server'

import { cookies } from 'next/headers'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { SHOP_SESSION_COOKIE } from '@/lib/shopSession'
import { recordEvent, type EventKind } from '@/lib/site/storefrontEvents'

/**
 * Recording a funnel event, from the public internet.
 *
 * Takes the store TOKEN like every other public action: the browser must never
 * name which tenant it writes to.
 *
 * ── IT RETURNS NOTHING, AND CANNOT FAIL ──────────────────────────────────
 *
 * void, deliberately. There is nothing a shopper's browser could usefully do
 * with the outcome, and an action that can fail is one a caller is tempted to
 * await and branch on — which would put analytics on the critical path of
 * adding something to a basket.
 *
 * ── THE VALUE IS NOT TAKEN FROM THE BROWSER ──────────────────────────────
 *
 * `purchase` events are recorded by the checkout action from the total the
 * SERVER computed, not from here. A basket value a shopper could set would
 * make the revenue figure worth nothing, and it is the one number in this
 * report a shop would act on.
 */
export async function recordEventAction(
  token: string,
  kind: EventKind,
  productId?: number | null,
): Promise<void> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return

  // Read from the cookie the layout set, never from the payload: a key the
  // caller supplies could be anyone's, and joining a stranger's view to your
  // purchase is worse than not joining it at all.
  const key = (await cookies()).get(SHOP_SESSION_COOKIE)?.value ?? ''
  if (!key) return

  await recordEvent(siteId, { kind, sessionKey: key, productId })
}

/*
 * Resolving "recently viewed" ids to products lives in `wishlistProductsAction`
 * (actions.ts), not here.
 *
 * That action is already "resolve these ids through the shop's publish rules,
 * dropping anything not for sale", which is exactly the question this row asks.
 * A second action doing the same thing would be a second place for the publish
 * rules to be forgotten.
 */

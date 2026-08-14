/**
 * What the till may do, and what it must not offer, while offline.
 *
 * Pure and no `server-only`, because `site/permissions.ts` is server-only and a
 * client component importing it would drag the database driver into the browser
 * bundle. The shape it reads is the flattened list `offlineOperators.ts` ships.
 *
 * ── THIS IS NOT A BOUNDARY ────────────────────────────────────────────────
 *
 * Everything here decides what a SCREEN offers. The real check happens twice on
 * the server: `checkPricing` when the sale is saved, and again when an offline sale
 * syncs, with the operator's capabilities re-derived from `users.role_id` rather
 * than read from anything the client sent. A till that granted itself a permission
 * would gain nothing.
 */

/** The sentinel that carries "this operator is an owner" across the boundary. */
const OWNER = '*'

/**
 * Whether this operator may do something, offline.
 *
 * Mirrors `permissions.can`, including the owner short-circuit — an owner's
 * capability set is a FLAG with an empty grant list, so a plain membership test
 * would refuse an owner everything.
 */
export function operatorCan(capabilities: readonly string[], capability: string): boolean {
  if (capabilities.includes(OWNER)) return true
  return capabilities.includes(capability)
}

/* ── What offline cannot do at all ───────────────────────────────────────── */

/**
 * Why this tender cannot be taken offline, or null when it can.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * A tender that depends on a BALANCE ONLY THE SERVER KNOWS is refused offline.
 * Not because the arithmetic is hard, but because there is no offline equivalent
 * of the rollback that protects it:
 *
 *   · An ACCOUNT sale needs a credit check. Checking against a balance that is
 *     hours stale is how a shop extends credit to somebody who has already
 *     exhausted it — and `creditRefusal` runs before any write precisely so that
 *     cannot happen.
 *   · LOYALTY points and a wallet are spent by functions that THROW rather than
 *     refuse, so an unaffordable redemption rolls the whole sale back. Offline
 *     there is nothing to roll back into.
 *
 * Cash and card are unaffected, which is the overwhelming majority of a till's
 * takings. The reason is returned as a sentence so the key can say it rather than
 * simply vanishing — a tender that disappears when the network drops leaves the
 * cashier wondering whether the store has the facility at all.
 */
export function offlineBlockedTender(tender: {
  postsToDebtor: boolean
  integrationKey: string | null
}): string | null {
  if (tender.postsToDebtor) return 'Account sales need the network'
  if (tender.integrationKey === 'loyalty') return 'Loyalty needs the network'
  // A gift card's balance lives only on the server, and the FOR UPDATE that
  // stops two tills draining one card has no offline equivalent.
  if (tender.integrationKey === 'gift_card') return 'Gift cards need the network'
  return null
}

/**
 * Why this product cannot be sold offline, or null when it can.
 *
 * Two cases, and both are about something the server has to work out:
 *
 *   · SERIAL-tracked stock. `checkSellable` reads the serial table and `markSold`
 *     has to write in the same transaction as the movement, so selling one offline
 *     would mean deciding locally which physical unit went out and hoping the
 *     server agreed later. It will not always agree — another till can sell the
 *     same serial in the meantime.
 *   · COMPOSITE products — `recipe` and `refer`. `resolveComponents` walks the
 *     composition tree with a recursive query, five levels deep, and it can
 *     legitimately REFUSE (a product that refers to itself). A till cannot run
 *     that walk, and guessing the components would post the wrong stock movements
 *     for goods that have already left the shop.
 *
 *     A NORMAL-METHOD refer is blocked for a second, stronger reason: selling one
 *     may BREAK A LARGER PACK OPEN, and which pack to open depends on live stock
 *     at every level of the chain. Two tills offline would each decide to open the
 *     last case. See referBreakdown.ts and 103_refer_methods.sql.
 *
 * `normal`, `returnable`, `service`, `buyout` and `calcqty` all sell offline, which
 * is nearly everything in nearly every shop.
 */
export function offlineBlockedProduct(product: { productType: string }): string | null {
  if (product.productType === 'serial') return 'Serial-tracked items need the network'
  if (product.productType === 'recipe' || product.productType === 'refer') {
    return 'Made-up and linked items need the network'
  }
  // Activating a card writes a balance only the server can arbitrate — a code
  // sold on two offline tills would be two cards wearing one number.
  if (product.productType === 'gift_card') return 'Gift cards need the network'
  return null
}

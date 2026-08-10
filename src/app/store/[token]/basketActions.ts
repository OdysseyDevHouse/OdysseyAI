'use server'

import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { getCustomerSession } from '@/lib/customerSession'
import { getOnlineSettings } from '@/lib/site/onlineStore'
import { saveBasket } from '@/lib/site/savedBaskets'
import { publishedProducts, storefrontContext } from '@/lib/site/storefront'

/**
 * "Save my basket" — from the public internet.
 *
 * Takes the store TOKEN rather than a site id, like every other public action:
 * the browser must never be able to name which tenant it writes to.
 *
 * ── THE SUBTOTAL IS COMPUTED HERE ────────────────────────────────────────
 *
 * The browser sends product ids and quantities. What the basket is worth is
 * read from the catalogue, exactly as checkout does — a posted price is not
 * validated, it is ignored. The figure only ever appears in the shop's own
 * reporting and in the reminder email, but a number a stranger can set is a
 * number that will eventually be set to something silly.
 *
 * ── IT REFUSES WHEN THE SHOP HAS NOT ASKED FOR IT ────────────────────────
 *
 * A store with reminders switched off stores nothing, even if a request
 * arrives. The box is not rendered for those shops, so any such call is
 * either stale or hand-made.
 */

export type SaveBasketResult = { ok: true } | { ok: false; error: string }

export async function saveBasketAction(
  token: string,
  input: {
    email: string
    name?: string
    lines: { productId: number; qty: number }[]
  },
): Promise<SaveBasketResult> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }

  const settings = await getOnlineSettings(siteId).catch(() => null)
  if (!settings?.isEnabled || !settings.basketReminders) {
    return { ok: false, error: "This shop isn't saving baskets at the moment." }
  }

  const context = await storefrontContext(siteId)
  if (!context) return { ok: false, error: 'This shop is closed at the moment.' }

  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((l) => ({ productId: Number(l.productId), qty: Number(l.qty) }))
    .filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0)
    .slice(0, 200)

  if (lines.length === 0) return { ok: false, error: 'There is nothing in your basket yet.' }

  // Priced from the catalogue. Also filters to what this shop actually
  // publishes, so a basket cannot be saved against something unpublished.
  const live = await publishedProducts(context, {
    ids: lines.map((l) => l.productId),
    limit: 200,
  })
  const byId = new Map(live.map((p) => [p.id, p]))
  const keep = lines.filter((l) => byId.has(l.productId))
  if (keep.length === 0) return { ok: false, error: 'These items are no longer on sale.' }

  const subtotal = keep.reduce(
    (sum, l) => sum + (byId.get(l.productId)?.priceIncl ?? 0) * l.qty,
    0,
  )

  // A signed-in shopper's own details win over anything typed: we already know
  // who they are, and their account name is the one the shop will recognise.
  const session = await getCustomerSession(siteId)

  const result = await saveBasket(siteId, {
    contactEmail: input.email,
    contactName: session?.name ?? input.name ?? '',
    customerId: session?.customerId ?? null,
    lines: keep,
    subtotalIncl: subtotal,
  })

  // The recovery token is deliberately NOT returned. The shopper reaches their
  // basket through the email, which is the whole point of leaving an address —
  // and handing a link straight back would let anyone mint one for any address
  // they typed.
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

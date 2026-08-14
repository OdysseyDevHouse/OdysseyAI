'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  generateGiftCards,
  adjustGiftCard,
  voidGiftCard,
  expireGiftCards,
  giftCardEvents,
  type GiftCardEvent,
} from '@/lib/site/giftCards'

export async function generateGiftCardsAction(
  count: number,
  note: string,
): Promise<{ ok: true; codes: string[] } | { ok: false; error: string }> {
  const ctx = await actorFor('giftcards.manage')
  if ('ok' in ctx) return ctx
  const result = await generateGiftCards(ctx.siteId, ctx.actor, { count, note })
  if (result.ok) revalidatePath('/gift-cards')
  return result
}

export async function adjustGiftCardAction(
  id: number,
  amount: number,
  note: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('giftcards.manage')
  if ('ok' in ctx) return ctx
  const result = await adjustGiftCard(ctx.siteId, ctx.actor, id, amount, note)
  if (result.ok) revalidatePath('/gift-cards')
  return result
}

export async function voidGiftCardAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('giftcards.manage')
  if ('ok' in ctx) return ctx
  const result = await voidGiftCard(ctx.siteId, ctx.actor, id)
  if (result.ok) revalidatePath('/gift-cards')
  return result
}

/**
 * The expiry sweep, and then its breakage journal.
 *
 * The journal posts AFTER the sweep's own transaction commits — a mirror
 * failure logs and leaves the cards expired, never the other way round.
 */
export async function runGiftCardExpiryAction(): Promise<
  { ok: true; cards: number; value: number } | { ok: false; error: string }
> {
  const ctx = await actorFor('giftcards.manage')
  if ('ok' in ctx) return ctx
  const swept = await expireGiftCards(ctx.siteId, ctx.actor)
  if (swept.cards > 0 && swept.value > 0.005) {
    const { mirrorGiftCardBreakage } = await import('@/lib/site/glPosting')
    const { today } = await import('@/lib/site/ledger')
    await mirrorGiftCardBreakage(ctx.siteId, ctx.actor, {
      date: today(),
      amount: swept.value,
      cards: swept.cards,
    })
  }
  revalidatePath('/gift-cards')
  return { ok: true, ...swept }
}

export async function giftCardEventsAction(
  id: number,
): Promise<{ ok: true; events: GiftCardEvent[] } | { ok: false; error: string }> {
  const ctx = await actorFor('giftcards.view')
  if ('ok' in ctx) return ctx
  return { ok: true, events: await giftCardEvents(ctx.siteId, id) }
}

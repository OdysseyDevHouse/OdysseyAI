'use server'

import { actorFor } from '@/lib/auth'
import {
  findGiftCard,
  giftCardRefusal,
  generateGiftCards,
  formatGiftCardCode,
  normaliseGiftCardCode,
} from '@/lib/site/giftCards'
import { today } from '@/lib/site/ledger'

/**
 * The till's window onto gift cards.
 *
 * Lookups only — nothing here moves a balance. Activation and redemption both
 * happen inside finaliseDocument's transaction, where a throw rolls the whole
 * sale back; these actions exist so the cashier hears a refusal BEFORE the
 * customer has packed their bags.
 */

export type GiftCardLookup =
  | {
      ok: true
      code: string
      /** XXXX-XXXX-XXXX, for the screen and the slip. */
      display: string
      status: 'fresh' | 'pending' | 'active'
      balance: number
      expiresOn: string | null
    }
  | { ok: false; error: string }

/**
 * What the till needs to know about a code, for either direction.
 *
 * `purpose` decides which states are good news: selling wants a code nobody
 * holds ('fresh' or 'pending'); paying wants an active balance.
 */
export async function lookupGiftCardAction(
  rawCode: string,
  purpose: 'sell' | 'redeem',
): Promise<GiftCardLookup> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const code = normaliseGiftCardCode(rawCode)
  if (code.length < 6) return { ok: false, error: 'That is not a gift card number.' }
  const display = formatGiftCardCode(code)

  const card = await findGiftCard(siteId, code)

  if (purpose === 'sell') {
    if (!card) return { ok: true, code, display, status: 'fresh', balance: 0, expiresOn: null }
    if (card.status === 'pending') {
      return { ok: true, code, display, status: 'pending', balance: 0, expiresOn: null }
    }
    return {
      ok: false,
      error:
        card.status === 'active'
          ? `Card ${display} is already active, holding ${card.balance.toFixed(2)}.`
          : `Card ${display} has already been ${card.status === 'void' ? 'cancelled' : 'used'} and cannot be sold.`,
    }
  }

  const refusal = giftCardRefusal(card, code, today())
  if (refusal) return { ok: false, error: refusal }
  return {
    ok: true,
    code,
    display,
    status: 'active',
    balance: card!.balance,
    expiresOn: card!.expiresOn,
  }
}

/** One fresh pending code, for a sale with no physical card to scan. */
export async function issueGiftCardCodeAction(): Promise<
  { ok: true; code: string; display: string } | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const result = await generateGiftCards(ctx.siteId, ctx.actor, {
    count: 1,
    note: 'Issued at the till',
  })
  if (!result.ok) return result
  return { ok: true, code: result.codes[0], display: formatGiftCardCode(result.codes[0]) }
}

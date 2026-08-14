'use server'

import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { findGiftCard, giftCardRefusal, formatGiftCardCode, normaliseGiftCardCode } from '@/lib/site/giftCards'
import { today } from '@/lib/site/ledger'

export async function checkGiftCardAction(
  token: string,
  code: string,
): Promise<
  | { ok: true; display: string; balance: number; expiresOn: string | null }
  | { ok: false; error: string }
> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }

  const card = await findGiftCard(siteId, code)
  const refusal = giftCardRefusal(card, code, today())
  if (refusal) return { ok: false, error: refusal }
  return {
    ok: true,
    display: formatGiftCardCode(normaliseGiftCardCode(code)),
    balance: card!.balance,
    expiresOn: card!.expiresOn,
  }
}

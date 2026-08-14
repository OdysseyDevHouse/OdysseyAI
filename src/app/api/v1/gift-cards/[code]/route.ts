import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { publicGiftCard } from '../../_lib/shapes'
import { findGiftCard } from '@/lib/site/giftCards'

export const dynamic = 'force-dynamic'

/**
 * Balance lookup by card number — what a partner site needs to answer "what
 * is on this card" before taking it as payment. Read-only: redemption still
 * only happens at a till, where the sale it pays for exists.
 */
export const GET = withApiKey(
  'gift-cards:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const card = await findGiftCard(ctx.siteId, decodeURIComponent(params.code ?? ''))
    if (!card) return NextResponse.json({ error: 'Gift card not found.' }, { status: 404 })
    return NextResponse.json(publicGiftCard(card))
  },
)

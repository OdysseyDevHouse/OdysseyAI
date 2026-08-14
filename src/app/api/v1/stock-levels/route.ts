import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../_lib/handler'
import { availableToSell } from '@/lib/site/stockMovements'

export const dynamic = 'force-dynamic'

/** GET /api/v1/stock-levels?ids=1,2,3 — availability for up to 200 products. */
export const GET = withApiKey('stock:read', async (req: NextRequest, ctx: ApiContext) => {
  const ids = (req.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200)
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Pass ids=1,2,3 — up to 200 product ids.' }, { status: 400 })
  }
  const availability = await availableToSell(ctx.siteId, ids)
  return NextResponse.json({
    items: ids.map((id) => {
      const a = availability.get(id)
      return {
        productId: id,
        onHand: a?.onHand ?? 0,
        onHandAllLocations: a?.onHandAllLocations ?? 0,
        reserved: a?.reserved ?? 0,
        available: a?.available ?? 0,
      }
    }),
  })
})

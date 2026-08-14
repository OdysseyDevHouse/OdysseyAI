import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../../_lib/handler'
import { locationStockFor } from '@/lib/site/stockLocations'

export const dynamic = 'force-dynamic'

export const GET = withApiKey(
  'stock:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid product id.' }, { status: 400 })
    }
    const locations = await locationStockFor(ctx.siteId, id)
    return NextResponse.json({
      items: locations.map((l) => ({
        locationId: l.locationId,
        code: l.code,
        name: l.name,
        isMain: l.isMain,
        stockOnHand: l.stockOnHand,
        minStock: l.minStock,
        maxStock: l.maxStock,
      })),
    })
  },
)

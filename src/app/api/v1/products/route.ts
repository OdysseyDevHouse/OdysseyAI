import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, type ApiContext } from '../_lib/handler'
import { publicProduct } from '../_lib/shapes'
import { listProducts } from '@/lib/site/products'

export const dynamic = 'force-dynamic'

export const GET = withApiKey('products:read', async (req: NextRequest, ctx: ApiContext) => {
  const { limit, offset } = pageParams(req)
  const q = req.nextUrl.searchParams
  const { items, total } = await listProducts(ctx.siteId, {
    search: q.get('search') ?? undefined,
    includeArchived: q.get('includeArchived') === '1',
    // The catalogue flat, not the variant-folded screen view: an integration
    // wants every sellable row, each exactly once.
    collapseVariants: false,
    limit,
    offset,
  })
  const withStock = ctx.scopes.has('stock:read')
  return NextResponse.json({
    items: items.map((p) => publicProduct(p, withStock)),
    total,
    limit,
    offset,
  })
})

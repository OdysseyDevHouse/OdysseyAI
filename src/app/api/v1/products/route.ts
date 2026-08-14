import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, sinceParam, type ApiContext } from '../_lib/handler'
import { publicProduct } from '../_lib/shapes'
import { listProducts } from '@/lib/site/products'

export const dynamic = 'force-dynamic'

export const GET = withApiKey('products:read', async (req: NextRequest, ctx: ApiContext) => {
  const { limit, offset } = pageParams(req)
  const q = req.nextUrl.searchParams
  const updatedSince = sinceParam(req)
  if (updatedSince === 'invalid') {
    return NextResponse.json(
      { error: 'updatedSince must be an ISO 8601 timestamp, e.g. 2026-08-01T00:00:00Z.' },
      { status: 400 },
    )
  }
  const { items, total } = await listProducts(ctx.siteId, {
    search: q.get('search') ?? undefined,
    // A delta poll includes archived rows by default: "it was archived" is a
    // change the sync exists to learn about. Full pulls keep the opt-in flag.
    includeArchived: q.get('includeArchived') === '1' || updatedSince !== null,
    // The catalogue flat, not the variant-folded screen view: an integration
    // wants every sellable row, each exactly once.
    collapseVariants: false,
    updatedSince: updatedSince ?? undefined,
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

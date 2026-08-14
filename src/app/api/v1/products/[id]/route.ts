import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { publicProduct } from '../../_lib/shapes'
import { getProduct } from '@/lib/site/products'

export const dynamic = 'force-dynamic'

export const GET = withApiKey(
  'products:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid product id.' }, { status: 400 })
    }
    const product = await getProduct(ctx.siteId, id)
    if (!product) return NextResponse.json({ error: 'Product not found.' }, { status: 404 })
    return NextResponse.json(publicProduct(product, ctx.scopes.has('stock:read')))
  },
)

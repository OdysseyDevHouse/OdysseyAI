import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, type ApiContext } from '../_lib/handler'
import { publicCustomer } from '../_lib/shapes'
import { listCustomers } from '@/lib/site/customers'

export const dynamic = 'force-dynamic'

export const GET = withApiKey('customers:read', async (req: NextRequest, ctx: ApiContext) => {
  const { limit, offset } = pageParams(req)
  const { items, total } = await listCustomers(ctx.siteId, {
    search: req.nextUrl.searchParams.get('search') ?? undefined,
    limit,
    offset,
  })
  return NextResponse.json({ items: items.map(publicCustomer), total, limit, offset })
})

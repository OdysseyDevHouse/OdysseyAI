import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, sinceParam, type ApiContext } from '../_lib/handler'
import { publicSupplier } from '../_lib/shapes'
import { listSuppliers, SUPPLIER_STATUSES } from '@/lib/site/suppliers'

export const dynamic = 'force-dynamic'

export const GET = withApiKey('suppliers:read', async (req: NextRequest, ctx: ApiContext) => {
  const { limit, offset } = pageParams(req)
  const updatedSince = sinceParam(req)
  if (updatedSince === 'invalid') {
    return NextResponse.json(
      { error: 'updatedSince must be an ISO 8601 timestamp, e.g. 2026-08-01T00:00:00Z.' },
      { status: 400 },
    )
  }
  const { items, total } = await listSuppliers(ctx.siteId, {
    search: req.nextUrl.searchParams.get('search') ?? undefined,
    // A delta poll must see every status: "this account closed" is exactly
    // the change a sync polls to learn.
    ...(updatedSince !== null ? { statuses: SUPPLIER_STATUSES, updatedSince } : {}),
    limit,
    offset,
  })
  return NextResponse.json({ items: items.map(publicSupplier), total, limit, offset })
})

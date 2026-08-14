import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { publicCustomer } from '../../_lib/shapes'
import { getCustomer } from '@/lib/site/customers'

export const dynamic = 'force-dynamic'

export const GET = withApiKey(
  'customers:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid customer id.' }, { status: 400 })
    }
    const customer = await getCustomer(ctx.siteId, id)
    if (!customer) return NextResponse.json({ error: 'Customer not found.' }, { status: 404 })
    return NextResponse.json(publicCustomer(customer))
  },
)

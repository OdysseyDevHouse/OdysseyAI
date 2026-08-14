import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { publicSalesDocument } from '../../_lib/shapes'
import { getDocument } from '@/lib/site/salesDocuments'

export const dynamic = 'force-dynamic'

export const GET = withApiKey(
  'sales:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid document id.' }, { status: 400 })
    }
    const document = await getDocument(ctx.siteId, id)
    if (!document) return NextResponse.json({ error: 'Document not found.' }, { status: 404 })
    return NextResponse.json(publicSalesDocument(document, true))
  },
)

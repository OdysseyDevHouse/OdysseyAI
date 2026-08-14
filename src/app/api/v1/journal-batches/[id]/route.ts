import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../../_lib/handler'
import { publicJournalBatch } from '../../_lib/shapes'
import { getBatch } from '@/lib/site/journals'

export const dynamic = 'force-dynamic'

export const GET = withApiKey(
  'gl:read',
  async (_req: NextRequest, ctx: ApiContext, params) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid batch id.' }, { status: 400 })
    }
    const batch = await getBatch(ctx.siteId, id)
    if (!batch) return NextResponse.json({ error: 'Batch not found.' }, { status: 404 })
    return NextResponse.json(publicJournalBatch(batch, true))
  },
)

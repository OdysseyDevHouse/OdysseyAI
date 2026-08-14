import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, type ApiContext } from '../_lib/handler'
import { publicJournalBatch } from '../_lib/shapes'
import { listBatches } from '@/lib/site/journals'

export const dynamic = 'force-dynamic'

/**
 * The accounting export: journal batches by date range. Headers only — fetch
 * a batch by id for its lines. Defaults to posted batches, because that is
 * what an external ledger wants to import; pass status=void to audit
 * reversals, or status=all for everything.
 */
export const GET = withApiKey('gl:read', async (req: NextRequest, ctx: ApiContext) => {
  const q = req.nextUrl.searchParams
  const status = q.get('status') ?? 'posted'
  if (!['posted', 'draft', 'void', 'all'].includes(status)) {
    return NextResponse.json(
      { error: 'status must be posted, draft, void or all.' },
      { status: 400 },
    )
  }
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000)
  const items = await listBatches(ctx.siteId, {
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    source: q.get('source') ?? undefined,
    status: status === 'all' ? undefined : status,
    limit,
  })
  return NextResponse.json({
    items: items.map((b) => publicJournalBatch(b, false)),
    limit,
  })
})

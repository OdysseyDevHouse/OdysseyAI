import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, type ApiContext } from '../_lib/handler'
import { publicPurchaseDocument } from '../_lib/shapes'
import {
  listPurchaseDocuments,
  PURCHASE_DOC_TYPES,
  type PurchaseDocType,
} from '@/lib/site/purchaseDocuments'

export const dynamic = 'force-dynamic'

export const GET = withApiKey('purchases:read', async (req: NextRequest, ctx: ApiContext) => {
  const { limit, offset } = pageParams(req)
  const q = req.nextUrl.searchParams

  const docType = q.get('docType')
  if (docType && !(PURCHASE_DOC_TYPES as readonly string[]).includes(docType)) {
    return NextResponse.json(
      { error: `docType must be one of: ${PURCHASE_DOC_TYPES.join(', ')}.` },
      { status: 400 },
    )
  }
  const supplierId = q.get('supplierId') ? Number(q.get('supplierId')) : undefined
  if (supplierId !== undefined && (!Number.isInteger(supplierId) || supplierId <= 0)) {
    return NextResponse.json({ error: 'Invalid supplierId.' }, { status: 400 })
  }

  const { items, total } = await listPurchaseDocuments(ctx.siteId, {
    docTypes: docType ? [docType as PurchaseDocType] : undefined,
    statuses: q.get('status') ? [q.get('status')!] : undefined,
    supplierId,
    search: q.get('search') ?? undefined,
    from: q.get('from') ?? undefined,
    to: q.get('to') ?? undefined,
    limit,
    offset,
  })
  return NextResponse.json({
    items: items.map((d) => publicPurchaseDocument(d, false)),
    total,
    limit,
    offset,
  })
})

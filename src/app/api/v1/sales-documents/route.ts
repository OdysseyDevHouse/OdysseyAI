import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey, pageParams, type ApiContext } from '../_lib/handler'
import { publicSalesDocument } from '../_lib/shapes'
import { listDocuments, type SalesDocType, type SalesDocStatus } from '@/lib/site/salesDocuments'

export const dynamic = 'force-dynamic'

const ISO = /^\d{4}-\d{2}-\d{2}$/
// Credit notes are invoices' negative twins and ride the invoice doc_type
// family; there is no separate 'credit_note' type in this schema.
const DOC_TYPES: readonly SalesDocType[] = ['invoice', 'credit_sale', 'quote', 'sales_order']
const STATUSES: readonly SalesDocStatus[] = ['draft', 'saved', 'issued', 'finalised', 'cancelled']

export const GET = withApiKey('sales:read', async (req: NextRequest, ctx: ApiContext) => {
  const q = req.nextUrl.searchParams
  const { limit, offset } = pageParams(req)
  const docType = q.get('docType')
  const status = q.get('status')
  const from = q.get('from')
  const to = q.get('to')
  const customerId = Number(q.get('customerId'))

  const { items, total } = await listDocuments(ctx.siteId, {
    docTypes: DOC_TYPES.includes(docType as SalesDocType) ? [docType as SalesDocType] : undefined,
    statuses: STATUSES.includes(status as SalesDocStatus)
      ? [status as SalesDocStatus]
      : ['finalised'],
    from: from && ISO.test(from) ? from : undefined,
    to: to && ISO.test(to) ? to : undefined,
    customerId: Number.isInteger(customerId) && customerId > 0 ? customerId : undefined,
    limit,
    offset,
  })
  return NextResponse.json({
    items: items.map((d) => publicSalesDocument(d, false)),
    total,
    limit,
    offset,
  })
})

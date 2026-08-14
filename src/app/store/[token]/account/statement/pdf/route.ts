import { NextResponse } from 'next/server'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { getCustomerSession } from '@/lib/customerSession'
import { issuingSiteFor } from '@/lib/site/invoiceEmail'
import { buildStatement } from '@/lib/statements/render'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * The shopper's own statement as a PDF.
 *
 * Under /store/ this URL is publicly routable, so the SESSION is the only
 * gate — and the customer id comes from it alone, never from the request.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const session = await getCustomerSession(siteId)
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const site = await issuingSiteFor(siteId)
  const data = await buildStatement(
    siteId,
    site?.displayName ?? '',
    site?.vatNumber ?? null,
    session.customerId,
    { format: 'open-item' },
  )
  if (!data) return NextResponse.json({ error: 'No statement' }, { status: 404 })

  const pdf = await renderStatementPdf(data)
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="statement.pdf"',
    },
  })
}

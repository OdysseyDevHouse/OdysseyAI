import { NextResponse } from 'next/server'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings } from '@/lib/site/portalAuth'
import { issuingSiteFor } from '@/lib/site/invoiceEmail'
import { buildStatement } from '@/lib/statements/render'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * The customer's own statement as a PDF, on the site's own stationery.
 *
 * The customer id comes from the SESSION and never from the request, so there
 * is no parameter here that could be pointed at somebody else's account. That
 * is the whole access-control story for this route, and it is why it takes no
 * customer argument at all rather than taking one and checking it.
 *
 * Renders through the same `renderStatementPdf` the back office and the
 * statement runs use, so what a customer downloads is what the shop would have
 * posted them — including the site's own statement design where it has one.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const siteId = await verifyPortalToken(token)
  if (siteId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The statement has its own switch, not merely the account side: a shop may
  // show transactions without issuing a statement document.
  const settings = await portalSettings(siteId)
  if (!settings.showStatement) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const session = await getCustomerSession(siteId)
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const site = await issuingSiteFor(siteId)
  const data = await buildStatement(
    siteId,
    site?.displayName ?? '',
    site?.vatNumber ?? null,
    session.customerId,
    // Open-item: what is still owed, document by document. An activity
    // statement is a period of movement, which is what the Transactions tab
    // already shows on screen.
    { format: 'open-item' },
  )
  if (!data) return NextResponse.json({ error: 'No statement' }, { status: 404 })

  const pdf = await renderStatementPdf(data, 'statement', siteId)

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="statement.pdf"',
      'cache-control': 'no-store',
    },
  })
}

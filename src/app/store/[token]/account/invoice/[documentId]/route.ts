import { NextResponse } from 'next/server'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { getCustomerSession } from '@/lib/customerSession'
import { getDocument } from '@/lib/site/salesDocuments'
import { HEADING, CLOSING, printKindFor } from '@/lib/site/salesDocumentKind'
import { issuingSiteFor } from '@/lib/site/invoiceEmail'
import { buildInvoice } from '@/lib/invoices/build'
import { renderInvoicePdf } from '@/lib/invoices/pdf'

/**
 * One of the shopper's own invoices as a PDF. The session is the gate, and
 * ownership is checked against the document itself — a guessed id on
 * somebody else's invoice 404s exactly like one that does not exist.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await params
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const session = await getCustomerSession(siteId)
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const id = Number(documentId)
  const document = Number.isInteger(id) && id > 0 ? await getDocument(siteId, id) : null
  if (!document || document.customerId !== session.customerId || document.status !== 'finalised') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const site = await issuingSiteFor(siteId)
  if (!site) return NextResponse.json({ error: 'Not available' }, { status: 404 })

  const data = await buildInvoice(siteId, site, id, {})
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  /*
   * A customer downloading their own paperwork may be downloading a CREDIT
   * NOTE. Without the kind it would head itself INVOICE, carry a negative total
   * and explain nothing — see salesDocumentKind.
   */
  const kind = printKindFor(document)
  const pdf = await renderInvoicePdf(data, siteId, {
    heading: HEADING[kind],
    closing: CLOSING[kind],
  })
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${(document.documentNumber ?? 'invoice').replace(/[^\w-]/g, '')}.pdf"`,
    },
  })
}

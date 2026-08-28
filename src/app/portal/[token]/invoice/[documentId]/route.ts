import { NextResponse } from 'next/server'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings } from '@/lib/site/portalAuth'
import { getDocument } from '@/lib/site/salesDocuments'
import { HEADING, CLOSING, printKindFor } from '@/lib/site/salesDocumentKind'
import { issuingSiteFor } from '@/lib/site/invoiceEmail'
import { buildInvoice } from '@/lib/invoices/build'
import { renderInvoicePdf } from '@/lib/invoices/pdf'

/**
 * One of the customer's own invoices — or credit notes — as a PDF.
 *
 * ── A ROUTE HANDLER CANNOT USE THE PAGE GUARD ──────────────────────────────
 *
 * `requireCustomer` redirects, which is right for a page and wrong here: a
 * fetch for a PDF that answers with a 307 to a sign-in page hands the browser
 * HTML labelled as a document. So the same four checks are made explicitly and
 * answer with status codes, in the same order and for the same reasons — see
 * guard.ts.
 *
 * ── OWNERSHIP IS CHECKED AGAINST THE DOCUMENT ──────────────────────────────
 *
 * The id in the path is the only thing the caller controls, and it is checked
 * against the session's customer before anything is rendered. A guessed id on
 * somebody else's invoice 404s exactly like one that does not exist — the same
 * answer, so the response cannot be used to find out which invoices exist.
 *
 * ── FINALISED ONLY ─────────────────────────────────────────────────────────
 *
 * A draft is the business still deciding what to charge. Handing a customer a
 * PDF of one starts an argument about a figure nobody ever issued.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await params

  const siteId = await verifyPortalToken(token)
  if (siteId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The account side must be on. Without this the jobs portal would quietly
  // serve invoices to a shop that only ever switched job tracking on.
  const settings = await portalSettings(siteId)
  if (!settings.accountsEnabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Takes the siteId, so a session minted at another business is refused —
  // customer ids collide across sites. See publicPortalToken.
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
      // Somebody else's document must never be served from a shared cache, and
      // a corrected re-issue must not be shadowed by an old copy.
      'cache-control': 'no-store',
    },
  })
}

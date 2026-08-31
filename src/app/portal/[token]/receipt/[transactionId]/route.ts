import { NextResponse } from 'next/server'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings } from '@/lib/site/portalAuth'
import { portalProfile } from '@/lib/site/portalData'
import { issuingSiteFor } from '@/lib/site/invoiceEmail'
import { buildReceipt } from '@/lib/statements/receipt'
import { renderStatementPdf } from '@/lib/statements/pdf'

/**
 * A receipt for one payment the customer made.
 *
 * ── ADDRESSED BY LEDGER TRANSACTION, NOT BY DOCUMENT ───────────────────────
 *
 * There is no receipt table. A customer payment is a `customer_transactions`
 * row and its allocations, so the id in the path is a transaction id and the
 * document is built from it at print time. See buildReceipt for what that
 * means when an allocation is later changed.
 *
 * ── OWNERSHIP IS CHECKED TWICE, ON PURPOSE ─────────────────────────────────
 *
 * Here, and again inside buildReceipt. The duplication is deliberate: that
 * function renders a transaction onto the shop's letterhead, and a helper whose
 * only protection is that its callers remember to check is one refactor away
 * from serving another customer's payment history. Neither check is load-
 * bearing alone.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; transactionId: string }> },
) {
  const { token, transactionId } = await params

  const siteId = await verifyPortalToken(token)
  if (siteId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const settings = await portalSettings(siteId)
  if (!settings.accountsEnabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const session = await getCustomerSession(siteId)
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })

  const id = Number(transactionId)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [site, profile] = await Promise.all([
    issuingSiteFor(siteId),
    // The same shopper-safe read the profile page uses, so the letterhead
    // cannot carry a field the account page has decided not to show.
    portalProfile(siteId, session.customerId),
  ])
  if (!site || !profile) return NextResponse.json({ error: 'Not available' }, { status: 404 })

  const data = await buildReceipt(
    siteId,
    site.displayName,
    site.vatNumber,
    session.customerId,
    id,
    {
      code: profile.code,
      name: profile.name,
      contactName: profile.contactName,
      email: profile.email,
      phone: profile.phone,
      vatNumber: profile.vatNumber,
      addressLines: profile.addressLines,
      paymentTermsDays: profile.paymentTermsDays,
    },
  )
  // Not a payment, not theirs, or gone. One answer for all three — the same
  // reason the invoice route gives.
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const pdf = await renderStatementPdf(data, 'receipt', siteId)

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="receipt-${id}.pdf"`,
      'cache-control': 'no-store',
    },
  })
}

import { NextResponse, type NextRequest } from 'next/server'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { consumeLink, portalSettings } from '@/lib/site/portalAuth'
import { createCustomerToken, CUSTOMER_COOKIE } from '@/lib/customerSession'

/**
 * Spend a sign-in link and start a session.
 *
 * ── WHY A ROUTE HANDLER AND NOT A PAGE ─────────────────────────────────────
 *
 * Because it sets a cookie. Next refuses cookie writes from a page — they may
 * only happen in a Server Action or a Route Handler — and the customer arrives
 * here by clicking a link in an email, which is a GET with no form to submit.
 * A Route Handler is the one primitive that is both.
 *
 * The cookie is set on the redirect RESPONSE rather than through the cookies()
 * helper, which is the same reason: the helper writes to a request-scoped store
 * that only an action or handler owns.
 *
 * ── A SCANNER MAY SPEND THE LINK BEFORE A HUMAN DOES ───────────────────────
 *
 * Some mail clients and security products fetch links to check them, which
 * consumes the link and leaves the customer with a dead one. Nothing here can
 * prevent that — it is the cost of magic links generally — so the failure page
 * says what happened plainly and asking for another takes ten seconds.
 *
 * ── THE LINK IS SPENT BEFORE THE SESSION IS MINTED ─────────────────────────
 *
 * consumeLink does its UPDATE first and only returns a claim if IT won the race,
 * so two clicks arriving together produce one session rather than two.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; link: string }> },
) {
  const { token, link } = await params
  const origin = request.nextUrl.origin

  const siteId = await verifyPortalToken(token)
  if (siteId === null) return NextResponse.redirect(`${origin}/`)

  const settings = await portalSettings(siteId)
  if (!settings.isEnabled) {
    return NextResponse.redirect(`${origin}/portal/${token}/closed`)
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null

  const claim = await consumeLink(siteId, link, ip)

  // A spent, expired or forged link all land on the same page, which explains
  // what happened without saying which of the three it was.
  if (!claim) {
    return NextResponse.redirect(`${origin}/portal/${token}/expired`)
  }

  const session = await createCustomerToken({
    siteId,
    customerId: claim.customerId,
    name: claim.customerName,
    // The portal has no password, so this is never true here.
    mustChange: false,
  })

  const response = NextResponse.redirect(`${origin}/portal/${token}/jobs`)
  response.cookies.set(CUSTOMER_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure in production only, so this still works over plain HTTP in
    // development — a cookie that never sets locally is a sign-in that appears
    // to succeed and then does nothing.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  })
  return response
}

import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session'

// Next 16 renamed the `middleware` convention to `proxy`; same signature, same
// place in the request lifecycle.
//
// Cheap gate only: it checks that a session cookie is *present*, not that it is
// valid — verifying the JWT needs the secret and would run on every asset
// request. Pages call requireSession()/requireSiteId() for the real check
// (which also re-confirms site access against the database).

// `/` is the login page. Matched exactly — as a prefix it would make every
// route public.
const PUBLIC_EXACT = ['/']
// `/store` is the customer-facing shop and is public BY DESIGN: shoppers have
// no account here. It is not unguarded — every route under it resolves an
// opaque signed token to a site and then reads only what that store has
// chosen to publish, so an invalid or absent token yields nothing at all.
// The payment gateway's server-to-server callback. It arrives from PayFast,
// not a browser, so it has no session and never will. It is not unguarded: the
// URL carries a signed token naming the store, and the payload must still pass
// signature, source-IP, post-back, merchant and amount checks.
const PUBLIC_PREFIXES = [
  '/forgot-password',
  '/reset-password',
  '/store/',
  '/api/payments/payfast/',
  // Product photographs for the public shop. Guarded the same way the shop
  // itself is: the URL carries the signed store token, and the route refuses
  // an image whose product that store does not publish.
  '/api/store-images/',
  // The scheduled-reports heartbeat. Cron calls it with no browser and no
  // session, so a cookie gate here would redirect it to the login page and the
  // scheduler would silently never run — a failure nobody would see until
  // someone noticed their morning report had stopped arriving.
  //
  // It is not unguarded: the route itself requires REPORT_CRON_SECRET, compares
  // it in constant time, and refuses every request outright when the secret is
  // not configured at all.
  '/api/reports/schedules/tick',
  // Contract billing's heartbeat. Same reasoning as the reports tick above, and
  // the same protection: CONTRACT_CRON_SECRET, compared in constant time, with
  // the route refusing everything when it is not set. Behind a cookie gate the
  // biller would 307 to the login page and silently never raise an invoice —
  // which nobody would notice until a customer mentioned they had not been
  // billed for a month.
  '/api/contracts/tick',
  // The landing page for an emailed "pay this invoice" link. The payer is a
  // customer, not a user of the back office, and will never have a session.
  //
  // It is not unguarded: the URL carries a signed token binding site and
  // payment intent together, the page shows only the invoice number, the payee
  // and the amount, and it can mark NOTHING paid — only the ITN callback does.
  '/pay/',
]

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    // Already signed in? Skip the login form.
    if (pathname === '/' && req.cookies.has(SESSION_COOKIE)) {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }
    return NextResponse.next()
  }

  if (!req.cookies.has(SESSION_COOKIE)) {
    const url = new URL('/', req.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Everything except Next internals, the health probe the Electron shell
    // waits on, and static files.
    '/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)',
  ],
}

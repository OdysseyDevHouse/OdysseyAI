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
// `/pos-unlock` is here for the reason given at POS_PATHS below: the visitor has
// no session by definition, and the screen reads nothing.
const PUBLIC_EXACT = ['/', '/pos-unlock']
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
  // The abandoned-basket sweep. Same reasoning and the same protection as the
  // two ticks above: BASKET_CRON_SECRET, compared in constant time, with the
  // route refusing every request when it is not set. Behind a cookie gate it
  // would 307 to the login page and no shopper would ever be reminded — a
  // failure with no symptom, because the feature's success state is also
  // silence.
  '/api/store/baskets/tick',
  // The landing page for an emailed "pay this invoice" link. The payer is a
  // customer, not a user of the back office, and will never have a session.
  //
  // It is not unguarded: the URL carries a signed token binding site and
  // payment intent together, the page shows only the invoice number, the payee
  // and the amount, and it can mark NOTHING paid — only the ITN callback does.
  '/pay/',
]

/**
 * The till, when its browser session has lapsed.
 *
 * A till offline overnight wakes with an expired cookie and a full outbox. Sending
 * it to the back-office login form is the one response that makes things worse:
 * nobody at a counter at 07:00 knows that password, and the shell the till needs in
 * order to FLUSH that outbox lives behind the redirect.
 *
 * So `/pos` goes to a POS-specific unlock screen instead. That screen is itself
 * public — the visitor has no session, it cannot be otherwise — and reads nothing
 * at all: a PIN pad and one sentence. Its action resolves the site from the
 * machine's own terminal claim, so an unclaimed device is refused before any PIN is
 * compared. See (pos)/pos-unlock/actions.ts.
 */
const POS_PATHS = ['/pos']
const POS_UNLOCK = '/pos-unlock'

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
    /*
     * An API route gets a 401, never a redirect to the login page.
     *
     * A redirect is right for a browser — the person sees the form and signs in. It
     * is actively harmful for a fetch: the till's background sync asks for JSON,
     * receives 200 OK with a page of HTML (the redirect is followed
     * transparently), and dies in JSON.parse with a syntax error that says nothing
     * about the real cause. Measured on /api/pos/catalog before this existed: it
     * answered 307 to `/?next=/api/pos/catalog`.
     */
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
    }

    // The till goes to its own unlock screen, not the back-office form.
    if (POS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return NextResponse.redirect(new URL(POS_UNLOCK, req.url))
    }

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
    /* `pos-sw.js` and `pos-manifest.json` are excluded because a service-worker
       SCRIPT that answers 307 does not register — and it fails SILENTLY. The till
       would simply have no offline shell, with nothing in the UI to say why, and
       the symptom would only appear the next time the network dropped. */
    '/((?!_next/static|_next/image|favicon.ico|api/health|pos-sw\\.js|pos-manifest\\.json|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)',
  ],
}

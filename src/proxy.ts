import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session'
import { MOBILE_SHELL_COOKIE, MOBILE_SHELL_HEADER } from '@/lib/mobileShellKeys'

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
// '/api-docs' is the developer reference for the public API. Public by design
// and EXACT rather than a prefix: the people who need it are integrators with
// no back-office login, who would otherwise meet a sign-in form for a system
// they have no account on. It is safe to publish because it describes the API
// and reads no store — every value on it comes from exported constants in the
// source, and the page opens no database connection. Exact, so a future
// '/api-docs-internal' does not become public by accident.
// '/database-setup' is Odyssey Database Setup's only screen, and '/api/db-setup'
// is the wizard's own back end. Both run BEFORE there is anything to have a
// session with: the technician is installing the database that the users table
// will eventually live in, so requiring a session here is asking them to sign in
// to a shop that does not exist yet. Without this the middleware answers the
// wizard's first call with a 401 before the route is reached.
//
// The API is not unguarded, and is guarded by something a cookie could not do
// here anyway: main.js mints a random key at startup into the environment the
// Next server inherits, and a caller that cannot present it gets a 404 — see
// src/app/api/db-setup/route.ts. Only Odyssey Database Setup ever mints one, so
// on a back office or a till these routes answer nothing at all.
//
// Exact for the screen, so a future '/database-setup-report' is not public by
// accident. The API is one route rather than a prefix, for the same reason.
const PUBLIC_EXACT = ['/', '/pos-unlock', '/api-docs', '/database-setup', '/api/db-setup']
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
  // The public "book a table" page. A guest booking a table is not a user of
  // the back office and will never have a session — behind a cookie gate the
  // restaurant's own "Book a table" button would send every guest to a login
  // screen for a system they have no account on.
  //
  // It is not unguarded: the URL carries a signed token scoped to one site with
  // its own audience, the page shows nothing but the shop's name and the times
  // it is offering, and the booking action re-derives those times server-side
  // before writing. The shop's reservation settings fail closed.
  //
  // The trailing slash matters, as it does for '/store/' above: a bare
  // '/reserve' would also make any future '/reservations…' route public.
  '/reserve/',
  // Rating the work on a finished job. The URL carries a signed token naming one
  // job on one site, with its own audience and a sixty-day life.
  //
  // Narrower than every other public route here: holding the link shows the job
  // NUMBER and title and nothing else — no prices, no address, no history — and
  // the only thing it can write is a star and a sentence onto a row that already
  // exists because the business asked for it. A token for a job nobody was asked
  // about updates nothing at all.
  //
  // The trailing slash matters, as it does for the routes above.
  '/feedback/',
  // Asking a business to do some work. The only PUBLIC WRITE endpoint in the
  // app besides a table booking, and it is guarded the same way that one is:
  // a honeypot answered with a fake success, a per-phone daily cap, and a switch
  // that fails closed.
  //
  // What makes it affordable is that what arrives is INERT. A submission is one
  // job_requests row — no job card, no customer, no address, no document number,
  // nothing that any figure reads — and it becomes a job only when somebody in
  // the business chooses a customer and accepts it.
  //
  // The trailing slash matters, as it does for the routes above.
  '/request/',
  /*
   * The customer portal. Public in the sense that the SIGN-IN page must be
   * reachable without a session — everything past it checks one.
   *
   * The guard is not this list. /portal/* reads the customer session cookie and
   * redirects to the sign-in when there is none, and every query behind it names
   * the customer id from that session in its WHERE. This entry only stops the
   * staff proxy from bouncing a customer to a back-office login they can never
   * pass, which is what it would otherwise do.
   *
   * The trailing slash matters, as it does for the routes above.
   */
  '/portal/',
  '/api/payments/payfast/',
  // The platform's OWN subscription callback — Odyssey collecting from a
  // tenant, as opposed to the entry above where a tenant collects from its
  // shoppers. PayFast posts here with no cookie and no browser.
  //
  // Leaving it out is the quietest way to break billing: every notification
  // gets a 307 to the login page, PayFast treats that as a failed delivery,
  // retries a few times and gives up. Money is taken and nothing is ever
  // recorded, with no error on either side.
  //
  // It is not unguarded: the URL carries a signed token naming one billing
  // account, and the route still requires a valid PayFast signature, a
  // PayFast source IP and PayFast's own confirmation of the payload before it
  // writes anything.
  //
  // The trailing slash matters, as it does for the routes above.
  '/api/billing/payfast/',
  // A technician's calendar subscription. Google, Outlook and Apple all fetch it
  // on a schedule with no browser and no cookie, so behind the gate they would
  // fetch the login page for ever and render an empty calendar with no error —
  // the failure that looks exactly like "nothing is booked".
  //
  // It is not unguarded: the URL carries a signed token naming one user on one
  // site, the query reads only that user's own appointments, and the feed
  // carries no financial data at all. Rotating SESSION_SECRET revokes every
  // subscription at once.
  //
  // The trailing slash matters, as it does for '/store/' and '/reserve/' above.
  //
  // '/feed/' rather than the whole of '/api/jobs/calendar/', and that narrowing
  // is load-bearing since 226. The OAuth link, callback and pull tick all live
  // under this path and NONE of them may be public: link would hand anybody an
  // authorisation redirect, callback calls requireModuleCapability and would
  // throw with no session, and the tick carries its own secret. A prefix here
  // is a decision about every route that will ever sit beneath it.
  '/api/jobs/calendar/feed/',
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
  // Platform billing's heartbeat — the annual increase, and the sweep that
  // makes PayFast agree with the price we hold locally. Same reasoning and the
  // same protection as the ticks either side: BILLING_CRON_SECRET, compared in
  // constant time, with the route refusing everything when it is not set.
  //
  // Its failure is quieter than most. Behind a cookie gate the sweep would 307
  // to the login page, and an account whose amount PayFast never accepted would
  // keep being debited the old figure indefinitely — the money keeps arriving,
  // just the wrong amount of it, which no error surfaces anywhere.
  '/api/billing/tick',
  // The abandoned-basket sweep. Same reasoning and the same protection as the
  // two ticks above: BASKET_CRON_SECRET, compared in constant time, with the
  // route refusing every request when it is not set. Behind a cookie gate it
  // would 307 to the login page and no shopper would ever be reminded — a
  // failure with no symptom, because the feature's success state is also
  // silence.
  '/api/store/baskets/tick',
  // The in-store box's flush — the loop that gets a hybrid shop's takings onto
  // the books. Same reasoning and the same protection as the ticks above:
  // BOX_CRON_SECRET, compared in constant time, with the route refusing every
  // request when it is not set.
  //
  // Its failure is the loudest of the set and still invisible for a while.
  // Behind a cookie gate it would 307 to the login page, the box would keep
  // accepting sales, and nothing would reach the cloud — so the shop trades
  // normally all day and the back office shows an empty till. Nothing errors,
  // because a queue filling up is exactly what the queue is for.
  '/api/pos/box-flush',
  // The low-stock digest tick. Same shape, its own LOW_STOCK_CRON_SECRET.
  // Without this entry it 307s to login and nobody is told stock ran out —
  // and the digest's success state is also silence, so watch the JSON.
  '/api/alerts/tick',
  // The webhook delivery tick. Same shape, WEBHOOK_CRON_SECRET; without this
  // entry every queued delivery quietly waits forever behind a login 307.
  '/api/webhooks/tick',
  // The public API. Its callers are programs holding an API key, never a
  // browser with a cookie — every route re-authenticates per request via
  // withApiKey (prefix lookup + constant-time SHA-256 compare), so this is a
  // change of authentication scheme, not an absence of one.
  '/api/v1/',
  // Scheduled page publishing. Same reasoning and the same protection again:
  // STOREFRONT_CRON_SECRET, compared in constant time, refusing everything when
  // it is not set. This one's failure mode is the most visible of the four —
  // behind a cookie gate a shop's Black Friday page simply never goes live, and
  // the owner finds out from the trading figures.
  '/api/storefront/publish',
  // Scheduled price changes. Same reasoning and the same protection once more:
  // PRICING_CRON_SECRET, compared in constant time, refusing everything when it
  // is not set. Behind a cookie gate the tills would still switch on time — they
  // carry the change and apply it themselves — but the database never would, so
  // the shop's screens, reports and online store would sit on the old prices
  // while the terminals charged the new ones. Two answers to what a thing costs
  // is the worst of the failure modes on this list.
  '/api/pricing/schedules/tick',
  // Recurring jobs' heartbeat. Same reasoning and the same protection as the
  // ticks above: JOB_SERIES_CRON_SECRET, compared in constant time, refusing
  // every request when it is not set.
  //
  // Its failure mode behind a cookie gate is the quietest on this list — a
  // quarterly service simply never appears, and nobody finds out until the
  // customer rings to ask why nobody came. There is no error, no missing
  // invoice, no wrong price: just work that was never raised.
  '/api/jobs/series/tick',
  // The three time-based job automations: escalate a breached SLA, remind before
  // a visit, raise the draft invoice on a closed job. JOB_AUTOMATION_CRON_SECRET,
  // its own secret, compared in constant time, 503 when it is not set.
  //
  // Behind a cookie gate this fails the same quiet way the series tick does, and
  // the escalation is the one that matters: a job breaches its promise, the
  // worklist shows it, and the person who could still act on it is never told.
  '/api/jobs/automations/tick',
  // The calendar pull. Reads linked calendars back for busy time and notices
  // anything somebody dragged. Its own secret, for the reason the two above
  // give: one secret across every tick means rotating it for one reason
  // silently breaks the others.
  '/api/jobs/calendar/tick',
  // The landing page for an emailed "pay this invoice" link. The payer is a
  // customer, not a user of the back office, and will never have a session.
  //
  // It is not unguarded: the URL carries a signed token binding site and
  // payment intent together, the page shows only the invoice number, the payee
  // and the amount, and it can mark NOTHING paid — only the ITN callback does.
  '/pay/',
  // The PRINTED pay code — the square on an invoice, statement or lay-by slip.
  //
  // Same reasoning as '/pay/' above and the same guarantees, but the link is
  // durable rather than a 24-hour token: paper is scanned weeks later and
  // several times over, so the code resolves to a revocable row instead.
  //
  // It is not unguarded. The code carries 70 bits of randomness, so it cannot
  // be walked; it names one site and one payable thing; the page shows only
  // what that thing is and what is owed on it TODAY — no line detail, no
  // account history, no contact details; and it can mark NOTHING paid, because
  // only the verified ITN does that.
  //
  // The trailing slash matters, as it does for every prefix here: a bare '/p'
  // would make any future '/products…' or '/portal…' route public.
  '/p/',
  // The mobile app's authentication. A phone arriving at first light has no
  // cookie by definition — these three routes are how it gets one, so a cookie
  // gate here is a locked door with the key inside it.
  //
  // The failure would not read as an auth problem either. The proxy answers
  // '/api/' with a 401 rather than a redirect, so the app would show "not
  // signed in" on a correct password, for ever, with nothing in any log to say
  // the request never reached the route.
  //
  // It is not unguarded, and each of the three carries its own scheme:
  // /login takes an email and password through the same signIn() the web form
  // uses — lockout, generic refusal and sign-in log included; /session and
  // /revoke take a bearer refresh token, hashed at rest and compared in
  // constant time, and /session re-reads the account's status and site access
  // on every call rather than trusting the token for anything but possession.
  '/api/mobile/auth/',
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

/**
 * Remember that this browser is the mobile app's WebView.
 *
 * The native shell sets `x-odyssey-shell: mobile` on the requests IT makes, but
 * a WebView does not attach custom headers to navigations the PAGE starts — a
 * tapped link, a redirect, a form post. So the header arrives on the first load
 * and never again, and without this the app would render its first screen bare
 * and grow a desktop sidebar on the second.
 *
 * Presentation only, and deliberately not signed or verified: setting it by
 * hand in a browser gets you the phone layout on a desktop, which is a
 * curiosity rather than an escalation. Every real check runs regardless — see
 * `src/lib/mobileShell.ts`.
 *
 * Wrapping the handler rather than editing its seven return points, because the
 * one that gets forgotten is the one that breaks a screen nobody tests.
 */
function rememberShell(req: NextRequest, res: NextResponse): NextResponse {
  if (req.headers.get(MOBILE_SHELL_HEADER)?.toLowerCase() !== 'mobile') return res
  if (req.cookies.get(MOBILE_SHELL_COOKIE)?.value === 'mobile') return res

  res.cookies.set(MOBILE_SHELL_COOKIE, 'mobile', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.APP_MODE !== 'desktop',
    path: '/',
    /* A year: the shell re-asserts the header on every cold start anyway, so
       this only has to outlive a session, and an expiry short enough to lapse
       mid-use would show up as the sidebar appearing for no reason. */
    maxAge: 60 * 60 * 24 * 365,
  })
  return res
}

export default function proxy(req: NextRequest) {
  return rememberShell(req, route(req))
}

function route(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    /*
     * EVICTED: the session was superseded by a sign-in somewhere else.
     *
     * `requireSession` cannot clear the cookie itself — deleting one is a WRITE,
     * and Next forbids cookie writes during a page render, so attempting it
     * throws and the user gets a server error instead of the login screen. The
     * middleware is the one layer that both sees every request and may write, so
     * the redirect carries `?kicked=1` and the actual clearing happens here.
     *
     * It has to happen SOMEWHERE, and cannot simply be left: the branch below
     * bounces anybody holding a session cookie off '/' to '/dashboard', which
     * would redirect straight back here — an infinite loop with the login form
     * never once rendered.
     */
    if (pathname === '/' && req.nextUrl.searchParams.get('kicked') === '1') {
      const res = NextResponse.next()
      res.cookies.delete(SESSION_COOKIE)
      return res
    }

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
    /* The service-worker SCRIPTS and manifests are excluded because a worker
       script that answers 307 does not register — and it fails SILENTLY. The
       screen would simply have no offline shell, with nothing in the UI to say
       why, and the symptom would only appear the next time the network dropped.
       `invoicing-sw.js` is here for the same reason `pos-sw.js` is: the
       invoicing window has its own shell, scoped to /invoicing. */
    '/((?!_next/static|_next/image|favicon.ico|api/health|pos-sw\\.js|pos-manifest\\.json|invoicing-sw\\.js|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)',
  ],
}

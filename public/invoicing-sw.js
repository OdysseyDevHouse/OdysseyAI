/**
 * The invoicing window's offline shell.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The window was built so a hardware shop whose local server dies keeps
 * invoicing. It did not: cutting the line and moving between screens dropped
 * the operator onto Chrome's own error page — the dinosaur, ERR_INTERNET_-
 * DISCONNECTED, the application gone. The screen already open survived because
 * nothing repainted it, and that was all.
 *
 * The till had `pos-sw.js` and this window had nothing. This is that worker's
 * twin, scoped to /invoicing, and it keeps the same four rules — each of which
 * was written from a real failure on the till, so none of them is re-litigated
 * here. See pos-sw.js for the full reasoning.
 *
 *   1. ONLY CLEAN 200s ARE CACHED, NEVER A REDIRECT. A lapsed session gets a
 *      307 to /login; cache that and the window opens the login screen from
 *      cache forever, signed in or not.
 *   2. STALE-WHILE-REVALIDATE FOR ASSETS, NOT CACHE-FIRST — so a new build is
 *      picked up on the next load rather than pinned forever.
 *   3. /api/* IS NEVER INTERCEPTED. Offline data behaviour belongs in the app,
 *      where it can be reasoned about, not in a worker that can lie about
 *      whether an invoice was saved.
 *   4. NAVIGATIONS ARE NETWORK-FIRST WITH A SHORT TIMEOUT. A slow line and a
 *      dead one look identical to somebody at a counter.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────
 *
 * It caches the SHELL, not the data. A register served from cache would show
 * yesterday's invoices as though they were today's, and a counter cannot tell
 * the difference. What the shell buys is that the operator stays inside the
 * application and is told what has happened — which is the floor the offline
 * capture path is built on, not a substitute for it.
 */

/* Bumped when what the worker CACHES or SERVES changes, not when the app does.
   A window already running v1 keeps its old worker until this differs — v2 adds
   the stale banner, which is a change to what a cached page LOOKS like. */
const VERSION = 'odyssey-invoicing-v2'
const PAGES = `${VERSION}-pages`
const ASSETS = `${VERSION}-assets`

/** How long a navigation waits for the network before falling back to cache. */
const NAV_TIMEOUT_MS = 4000

/**
 * The shell pages worth holding — all four, because any can be the entry point.
 *
 * A counter that opened on Quotes and lost the line must not find Quotes is the
 * one screen that does not come back. The till caches both its entry points for
 * the same reason.
 */
const SHELL = ['/invoicing', '/invoicing/quotes', '/invoicing/orders', '/invoicing/laybys']

self.addEventListener('install', (event) => {
  // Warm the shell, but do not fail the install if it cannot be fetched — a
  // first load with no network should still register the worker for next time.
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      /* Anything not belonging to THIS version goes. Keyed on the version prefix
         rather than an explicit list, so a renamed cache cannot be orphaned.
         Scoped to our own prefix as well: the till's caches live in the same
         origin and are none of this worker's business. */
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('odyssey-invoicing-') && !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

/** Rule 1. A response is only worth keeping if it is exactly what was asked for. */
function cacheable(response) {
  return Boolean(
    response &&
      response.status === 200 &&
      !response.redirected &&
      response.type !== 'opaqueredirect',
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  /* Rule 3, and non-GETs generally. Server actions are POSTs; letting them near
     a cache would be catastrophic and pointless in equal measure. */
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Rule 4 — the shell.
  if (request.mode === 'navigate') {
    event.respondWith(navigateWithFallback(request))
    return
  }

  // Rule 2 — everything the shell needs to render.
  if (
    url.pathname.startsWith('/_next/static/') ||
    ['script', 'style', 'font', 'image'].includes(request.destination)
  ) {
    event.respondWith(staleWhileRevalidate(request))
  }
})

/**
 * Network first, cache after four seconds.
 *
 * The timeout is a RACE, not a sequence: a slow network and a dead one look the
 * same from a counter, and both must open the shell rather than spin.
 */
async function navigateWithFallback(request) {
  const cache = await caches.open(PAGES)

  const network = (async () => {
    const response = await fetch(request)
    // Rule 1. A 307 to /login is a fine response to SERVE and a catastrophic
    // one to KEEP.
    if (cacheable(response)) cache.put(request, response.clone()).catch(() => {})
    return response
  })()

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS))

  try {
    const winner = await Promise.race([network, timeout])
    if (winner) return winner
  } catch {
    // Offline, DNS failure, connection reset — fall through to the cache.
  }

  /* The asked-for screen, else the register — which is the window's own front
     door and the honest fallback for a screen never opened online. */
  const cached = (await cache.match(request)) ?? (await cache.match('/invoicing'))
  if (cached) return await markStale(cached)

  /*
   * Never seen online, and no network now.
   *
   * Says so plainly rather than showing the browser's error, which suggests the
   * machine is broken — the exact confusion this whole worker exists to end.
   */
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Invoicing offline</title>' +
      '<body style="font:16px system-ui;padding:2rem;text-align:center">' +
      '<h1 style="font-size:1.25rem">This machine has not been set up for offline invoicing yet</h1>' +
      '<p>Connect it to the network once, open invoicing, and it will work offline after that.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

/**
 * Stamps a served-from-cache page so it cannot pass for a live one.
 *
 * ── WHY THE WORKER HAS TO DO THIS ─────────────────────────────────────────
 *
 * The chrome carries an "Offline" chip driven by `navigator.onLine`, and on the
 * screen already open it works. It does NOT work on a page served from here,
 * and the reason is worth writing down: Next's client router fails to fetch the
 * RSC payload, logs "Falling back to browser navigation", and does a full page
 * load. React never hydrates that document — measured, polled for twelve
 * seconds — so no client state runs and the chip never appears.
 *
 * The result was the worst possible screen: a register showing yesterday's
 * invoices with nothing to say they were yesterday's. An operator cannot tell,
 * and "cached data presented as live" is a worse failure than the dinosaur page
 * this whole worker replaced.
 *
 * So the banner is injected into the HTML itself, by the only thing that knows
 * the response came from cache. Plain markup and inline styles because there is
 * no guarantee a stylesheet loads, and `!important` on the layout properties
 * because it must survive whatever the page's own CSS does.
 */
function markStale(response) {
  const type = response.headers.get('Content-Type') || ''
  // Only HTML documents. A cached JSON or asset must pass through untouched.
  if (!type.includes('text/html')) return response

  return response
    .text()
    .then((html) => {
      const banner =
        '<div role="status" style="position:fixed!important;top:0;left:0;right:0;z-index:2147483647;' +
        'padding:10px 16px;text-align:center;font:600 14px system-ui,sans-serif;' +
        'background:#fbbf24;color:#1c1917">' +
        'Offline — showing the last data this machine saw. New work is not being saved yet.' +
        '</div>' +
        /* Pushes the page down by the banner's height, so it covers nothing. */
        '<div style="height:40px"></div>'

      /* After the opening <body>, so it is the first thing painted. A page with
         no <body> tag (an error document, say) gets it prepended instead —
         which still renders, because browsers are forgiving about this. */
      const out = /<body[^>]*>/i.test(html)
        ? html.replace(/(<body[^>]*>)/i, `$1${banner}`)
        : banner + html

      const headers = new Headers(response.headers)
      /* Observable from the page, and from a verifier: proves the response came
         from cache rather than the network, which the HTML alone cannot say. */
      headers.set('X-Odyssey-Stale', '1')
      return new Response(out, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    })
    .catch(() => response)
}

/**
 * Serve the cached copy immediately, refresh it in the background.
 *
 * Rule 2. The window renders instantly from cache and picks up a new build on
 * the NEXT load — the right trade for an asset, and the opposite of what
 * cache-first does.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS)
  const cached = await cache.match(request)

  const refresh = fetch(request)
    .then((response) => {
      if (cacheable(response)) cache.put(request, response.clone()).catch(() => {})
      return response
    })
    .catch(() => null)

  return cached ?? (await refresh) ?? fetch(request)
}

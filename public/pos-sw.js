/**
 * The till's offline shell.
 *
 * Caches enough of /pos to open with no network. It does NOT cache data — the
 * catalog, the basket and the outbox all live in IndexedDB, which the app owns.
 *
 * ── FOUR RULES, EACH FROM A REAL FAILURE ─────────────────────────────────
 *
 * 1. ONLY CLEAN 200s ARE CACHED, NEVER A REDIRECT.
 *    A till whose session lapses gets a 307 to /pos-unlock. Cache that and the
 *    till opens the unlock screen from cache forever, even signed in — the shop
 *    is bricked until somebody clears storage. This is the single most important
 *    line in the file.
 *
 * 2. STALE-WHILE-REVALIDATE FOR ASSETS, NOT CACHE-FIRST.
 *    The reference POS pinned the first stylesheet it ever saw and served it
 *    against newly-deployed markup. Tills rendered a broken layout that no reload
 *    fixed, because cache-first never asks again.
 *
 * 3. /api/* IS NEVER INTERCEPTED.
 *    Offline data behaviour belongs in the app, where it can be reasoned about. A
 *    worker that serves a cached catalog — or worse, fakes a sync response — is a
 *    worker that lies about whether a sale was saved.
 *
 * 4. NAVIGATIONS ARE NETWORK-FIRST WITH A SHORT TIMEOUT.
 *    4 seconds, not 30. A cashier standing at a dead line does not wait; the
 *    cached shell opens and the outbox keeps filling.
 */

const VERSION = 'odyssey-pos-v1'
const PAGES = `${VERSION}-pages`
const ASSETS = `${VERSION}-assets`

/** How long a navigation waits for the network before falling back to cache. */
const NAV_TIMEOUT_MS = 4000

/** The shell pages worth holding. Both, because either can be the entry point. */
const SHELL = ['/pos', '/pos-unlock']

self.addEventListener('install', (event) => {
  // Warm the shell, but do not fail the install if it cannot be fetched — a first
  // load with no network should still register the worker for next time.
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
      // Anything not belonging to THIS version goes. Keying on the version prefix
      // rather than an explicit list means a renamed cache cannot be orphaned.
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
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

  // Rule 3, and non-GETs generally. Server actions are POSTs; letting them near a
  // cache would be catastrophic and pointless in equal measure.
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
 * same to the till, and both must open the shell rather than spin.
 */
async function navigateWithFallback(request) {
  const cache = await caches.open(PAGES)

  const network = (async () => {
    const response = await fetch(request)
    // Rule 1. A 307 to /pos-unlock is a perfectly good response to SERVE and a
    // catastrophic one to KEEP.
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

  const cached = (await cache.match(request)) ?? (await cache.match('/pos'))
  if (cached) return cached

  // Never seen online, and no network now. Say so plainly rather than showing the
  // browser's own error, which suggests the machine is broken.
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Till offline</title>' +
      '<body style="font:16px system-ui;padding:2rem;text-align:center">' +
      '<h1 style="font-size:1.25rem">This till has not been set up offline yet</h1>' +
      '<p>Connect it to the network once, open the till, and it will work offline after that.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

/**
 * Serve the cached copy immediately, refresh it in the background.
 *
 * Rule 2. The till renders instantly from cache and picks up a new build on the
 * NEXT load — which is the right trade for an asset, and the opposite of what
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

  if (cached) {
    // Not awaited: the point is that the cached copy answers now.
    refresh.catch(() => {})
    return cached
  }
  return (await refresh) ?? Response.error()
}

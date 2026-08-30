import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The iOS and Android shell around the back office.
 *
 * ── THIS APP SHIPS NO WEB ASSETS ────────────────────────────────────────────
 *
 * The usual Capacitor app bundles a built site into the binary and runs it from
 * the file system. This one points at the live server instead, because the
 * thing being wrapped is a Next app with server components, server actions and
 * a database behind it — there is no static export of it, and there could not
 * be one without rebuilding the product as a client-side SPA.
 *
 * `webDir` still has to exist or the CLI refuses to sync, so it names a folder
 * holding one placeholder page. Nothing ever loads it: `server.url` wins.
 *
 * ── WHY THE URL IS NOT HARDCODED HERE ───────────────────────────────────────
 *
 * Every shop is a different host. `ODYSSEY_APP_URL` is read at BUILD time so a
 * white-labelled build can point at its own server, and the default is the
 * cloud one most customers are on. A shop on its own domain gets its own build
 * rather than a settings screen asking a manager to type a URL — an app that
 * can be pointed anywhere is an app that can be pointed at an attacker.
 *
 * ── HTTPS ONLY, AND THAT IS A PRODUCT DECISION ──────────────────────────────
 *
 * `androidScheme: 'https'` and no cleartext exception on either platform. iOS
 * App Transport Security would refuse plain HTTP anyway, and the workarounds
 * (NSAllowsArbitraryLoads) weaken transport security for EVERY customer to
 * accommodate the few on a LAN. Local-backend sites are therefore out of scope
 * for the app until they can be reached over TLS — see docs/mobile-app.md.
 */

/*
 * No default, deliberately.
 *
 * This used to fall back to a plausible-looking hostname that did not exist,
 * and the result was an app that installed, opened, and showed Chrome's
 * ERR_NAME_NOT_RESOLVED page — which reads as a broken app rather than as an
 * unset variable. Failing at BUILD time with a sentence naming the fix is the
 * version somebody can act on.
 */
const APP_URL = process.env.ODYSSEY_APP_URL

if (!APP_URL) {
  throw new Error(
    'ODYSSEY_APP_URL is not set — the app would build with nowhere to point.\n' +
      '  production:  ODYSSEY_APP_URL=https://your-host npm run mobile:sync\n' +
      '  dev on LAN:  ODYSSEY_APP_URL=http://192.168.x.x:4100 npm run mobile:sync\n' +
      'It must be the address a PHONE can reach: localhost on a handset is the handset.',
  )
}

const url = new URL(APP_URL)

/*
 * A plain-HTTP target is a DEV target, and saying so in one place keeps the
 * two builds from drifting.
 *
 * Cleartext is never right in production — a signed-in session over plain HTTP
 * is a credential on the wire — but a dev server on a laptop has no
 * certificate, and refusing to talk to it means the app can never be seen
 * working before it is released. So the exception is derived from the URL
 * rather than being a flag somebody can leave switched on: point the build at
 * https and it turns itself off.
 *
 * Android only. iOS App Transport Security refuses cleartext regardless, and
 * the escape hatch (NSAllowsArbitraryLoads) weakens transport security for the
 * whole app rather than for one host — so iOS dev testing needs a real
 * certificate. See docs/mobile-app.md.
 */
const isDev = url.protocol === 'http:'

/*
 * A TILL build, rather than the back office in a box.
 *
 * `ODYSSEY_POS_ONLY=1` produces an APK that opens on the touch till, for a
 * counter tablet. The two are genuinely different products on the same server:
 * the back office is a manager checking figures on the move, the till is the
 * thing a shop trades on, and they want opposite chrome.
 *
 * A build input rather than a setting, for the same reason the URL is one — a
 * device is bought to be one or the other, and a till a cashier can navigate
 * out of is a back office one tap behind the basket.
 */
const posOnly = process.env.ODYSSEY_POS_ONLY === '1'

/*
 * Which shop this till belongs to.
 *
 * A counter tablet trades for ONE shop, and the exchange has no way to know
 * which: it runs before any screen exists, so there is nobody to ask. Without
 * this it falls back to the first store the account can open — an arbitrary
 * row, not a choice — and a multi-store owner gets a till ringing up sales
 * against whichever shop happens to sort first.
 *
 * A build input rather than a picker, for the reason the URL and the start
 * path are: the device is installed at a counter and its shop does not change.
 * A picker would also be a picker a cashier could get WRONG, which is a sale
 * posted to another branch.
 *
 * Optional. Left unset the old behaviour stands, which is right for the back
 * office — a manager on the move genuinely does switch stores.
 */
const rawSiteId = process.env.ODYSSEY_SITE_ID
const siteId = rawSiteId ? Number(rawSiteId) : undefined

if (rawSiteId && !Number.isInteger(siteId)) {
  throw new Error(
    `ODYSSEY_SITE_ID must be a whole number — got "${rawSiteId}".\n` +
      '  example:  ODYSSEY_SITE_ID=53 ODYSSEY_POS_ONLY=1 npm run mobile:sync',
  )
}

const config: CapacitorConfig = {
  appId: 'za.co.odyssey.backoffice',
  appName: 'Odyssey',
  webDir: 'mobile/www',

  server: {
    url: APP_URL,
    /*
     * The WebView refuses to load anything off this host, so a link to a
     * payment gateway or a mis-typed redirect cannot silently take the app
     * somewhere it should not be. Anything genuinely external is opened in the
     * system browser by the shell instead.
     */
    allowNavigation: [url.host],
    cleartext: isDev,
    androidScheme: isDev ? 'http' : 'https',
    /*
     * Where the WebView opens, on a till build.
     *
     * Read natively as `server.appStartPath` and appended to the app URL
     * BEFORE the first load, so the till is the first paint rather than a
     * redirect away from a dashboard the person on a counter tablet is never
     * meant to see.
     *
     * Cast because this CLI version's `CapacitorConfig` type does not declare
     * the key. The Android runtime reads it from the generated JSON regardless
     * — see `CapConfig.getStartPath`, which does `appUrl += startPath`.
     */
    ...(posOnly ? ({ appStartPath: '/pos' } as { appStartPath: string }) : {}),
    /*
     * Read by the native shell, not by Capacitor — it rides in this file
     * because `BuildConfigUrl` already parses it and a second config would be
     * a second thing to keep in step with the URL.
     */
    ...(siteId === undefined ? {} : ({ odysseySiteId: siteId } as { odysseySiteId: number })),
  },

  android: {
    /* The web layer decides what the chrome looks like — see MobileTopBar. The
       native side keeps the status bar and the back gesture and nothing else. */
    backgroundColor: '#0b0f14',
  },

  ios: {
    backgroundColor: '#0b0f14',
    /*
     * The WebView must not bounce past the top of a page. On a screen whose own
     * header is drawn in HTML, rubber-banding drags that header away from the
     * status bar and back — the single most obvious tell that an app is a
     * website in a box.
     */
    scrollEnabled: true,
    contentInset: 'always',
  },

  plugins: {
    /* No splash plugin: the shell shows its own view until the first paint, so
       a second splash would be two loading screens in a row. */
  },
}

export default config

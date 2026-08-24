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

const APP_URL = process.env.ODYSSEY_APP_URL ?? 'https://app.odyssey.co.za'

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
    allowNavigation: [new URL(APP_URL).host],
    // Never true. A mixed-content page inside a signed-in session is exactly
    // the shape of a credential leak.
    cleartext: false,
    androidScheme: 'https',
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

'use client'

/**
 * The sign-in form, filled in for whoever is debugging the desktop shell.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A desktop run signs out on launch (see electron/signOutOnLaunch.js), so every
 * `npm run dev:desktop` starts at the front door. Typing the same name and PIN
 * back in is the first thing a developer does dozens of times a day, and it is
 * a keystroke tax on every restart rather than anything anybody is testing.
 *
 * ── WHY IT CANNOT BE A .env VALUE ─────────────────────────────────────────
 *
 * The obvious shape — read it from `NEXT_PUBLIC_DEV_PIN` — is the wrong one,
 * because a `NEXT_PUBLIC_` variable is INLINED into the client bundle at build
 * time, and the same bundle ships to every customer. Whatever was in the
 * developer's environment when `npm run dist` ran would be sitting in the
 * installed app's JavaScript, readable by anybody. A constant that is only ever
 * READ behind a runtime check leaks nothing but this fake operator's name.
 *
 * ── AND WHY THE GATE IS THE SHELL, NOT NODE_ENV ───────────────────────────
 *
 * `process.env.NODE_ENV` is inlined too, and it is `production` in a packaged
 * build — so it would be right by accident here, and wrong the moment somebody
 * debugs against a production build. `window.odyssey.isDev` is the shell's own
 * `app.isPackaged`, relayed by electron/preload.js. It is undefined in a
 * browser, so the web build never fills anything in — a public login form that
 * types a name into itself is not a debugging aid, it is a support call.
 */

/**
 * The operator a desktop debug session signs in as.
 *
 * Matches the local (name + PIN) form rather than the cloud one: the machine a
 * developer runs the shell on is a shop's own machine, and it authenticates
 * against the site's `users` table — see lib/localSignIn.ts.
 */
export const DEV_SIGN_IN = {
  name: 'Tiaan Smith',
  pin: '1122',
} as const

type OdysseyBridge = {
  isDesktop?: boolean
  isDev?: boolean
}

/**
 * Should the form fill itself in?
 *
 * Both halves are required and neither is redundant. `isDesktop` says a shell
 * exposed this bridge at all; `isDev` says that shell is an unpackaged
 * checkout. An installed Odyssey answers true and false, and gets nothing.
 *
 * FALSE DURING SSR, deliberately, and the caller must treat it that way: this
 * is only ever knowable in the browser, so the fill happens after hydration
 * rather than in the rendered HTML. Server-rendering it would put a PIN in the
 * markup of a page the web build also serves.
 */
export function fillSignInForDebug(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as unknown as { odyssey?: OdysseyBridge }).odyssey
  return bridge?.isDesktop === true && bridge?.isDev === true
}

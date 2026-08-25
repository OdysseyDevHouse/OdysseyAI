// What this installation is FOR.
//
// ── WHY THIS IS BAKED, WHEN connection_type IS NOT ──────────────────────────
//
// Two different questions get decided in two different places, and keeping them
// apart is the whole point of this module:
//
//   · WHERE THE DATA LIVES — cloud / local / hybrid — is a property of the
//     SITE. It is read from cp2_sites.connection_type, cached on the device at
//     sign-in, and can be changed in the control panel without anyone
//     reinstalling anything. A franchise must never be handed a different
//     download because of it.
//
//   · WHAT THE MACHINE IS FOR — back office / till / database setup — is a
//     property of the INSTALL. It cannot come from the control panel, because
//     a till must open straight to the clerk PIN with no admin login reachable
//     AT ALL. If one build could be either, the back office would be present on
//     the machine and merely hidden, and a manager who knows a URL can reach a
//     hidden thing.
//
// So the role is written into package.json at build time by the `extraMetadata`
// block in build-config/*.yml, and read back here.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not a security boundary. A packaged window has no address bar and no
// devtools, and setWindowOpenHandler intercepts window.open — so a cashier
// cannot type their way into /purchasing, and that much is genuinely closed.
// But the Next server still serves those routes, and on a hybrid site the box
// is on the shop LAN where any machine with a browser can reach it.
//
// The real boundary is where it already is: actorForModule and
// requireModuleCapability on every action. A POS-only user cannot do
// back-office things regardless of which EXE they are sitting at. This makes
// the machine's purpose unambiguous and the wrong thing unreachable in normal
// use — a real goal, and a different one.
const path = require('node:path')

/** The three installers. Anything else is a developer checkout. */
const ROLES = ['backoffice', 'pos', 'database']

let cached = null

/**
 * Which installer produced this app.
 *
 * Defaults to `backoffice` when nothing says otherwise, which is what a `npm
 * run dev:desktop` checkout is: the full app, exactly as it behaved before
 * there were three builds. An unpackaged developer run must not accidentally
 * become a locked-down till.
 *
 * ODYSSEY_ROLE overrides, so a developer can exercise the till build — and a
 * support engineer can prove a behaviour — without producing an installer.
 */
function appRole() {
  if (cached) return cached

  const fromEnv = String(process.env.ODYSSEY_ROLE || '').toLowerCase()
  if (ROLES.includes(fromEnv)) {
    cached = fromEnv
    return cached
  }

  try {
    /* package.json sits beside this directory in a checkout, and inside the
       asar in a packaged build. require() resolves both. */
    const pkg = require(path.join(__dirname, '..', 'package.json'))
    const baked = String(pkg.odysseyRole || '').toLowerCase()
    if (ROLES.includes(baked)) {
      cached = baked
      return cached
    }
  } catch {
    /* No package.json readable. Fall through to the default rather than
       refusing to start: a machine that cannot read its own role is still a
       machine somebody is trying to trade on. */
  }

  cached = 'backoffice'
  return cached
}

/** The till build: boots /pos, and may not leave it. */
function isPos() {
  return appRole() === 'pos'
}

/** The database provisioner: no Next server, no shop UI. */
function isDatabaseSetup() {
  return appRole() === 'database'
}

/**
 * Where the shell should land.
 *
 * The till goes straight to /pos. It does NOT go to a sign-in page first: after
 * the one admin sign-in that tells this machine which site and device it is,
 * (pos)/layout.tsx serves the clerk PIN screen itself — it deliberately has no
 * auth gate, precisely so it can do that when a session has lapsed overnight.
 */
function startPath() {
  if (isPos()) return '/pos'
  /* Odyssey Database Setup is not a back office that happens to install a
     database — it is a wizard, and it is the ONLY thing that build does. It
     therefore opens on its own screen rather than the login form, which on this
     machine would ask for an account whose database does not exist yet. */
  if (isDatabaseSetup()) return '/database-setup'
  return '/'
}

/**
 * Where the till build is allowed to go, judged on the PATH alone.
 *
 * ── WHY A LIST AND NOT JUST /pos ──────────────────────────────────────────
 *
 * A till is not only the till screen. It legitimately leaves it in three ways,
 * and a guard allowing `/pos*` alone breaks every one of them:
 *
 *   · `/pos-unlock` — where proxy.ts sends a session-less `/pos`. This is how a
 *     till that slept overnight gets back in, and it is the FIRST thing a
 *     freshly installed machine sees.
 *   · `/not-allowed` — where pos/page.tsx redirects somebody without the
 *     `sales.till` capability. Blocking it leaves a cashier on a dead screen
 *     with nothing explaining why.
 *   · `/` — the login form. The till needs it for the one admin sign-in that
 *     tells this machine which site and device it is, and it is the way out of
 *     the unlock screen for somebody who is not a cashier.
 */
const POS_ALLOWED_EXACT = ['/', '/not-allowed']

function isPosPath(url) {
  try {
    const { pathname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    if (POS_ALLOWED_EXACT.includes(pathname)) return true
    return pathname === '/pos' || pathname.startsWith('/pos-') || pathname.startsWith('/pos/')
  } catch {
    return false
  }
}

/**
 * Where the database-setup build is allowed to go.
 *
 * Narrower than the till's list, because this build has fewer legitimate
 * destinations than any other: there is no shop yet, no session, and nothing to
 * sign in to. Everything the wizard needs lives under one path.
 *
 * `/not-allowed` is not here for the reason it is on the till list — nothing in
 * this build checks a capability — but a refusal has to land somewhere, and a
 * blank window is worse than a page that explains itself.
 */
function isSetupPath(url) {
  try {
    const { pathname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return pathname === '/database-setup' || pathname.startsWith('/database-setup/')
  } catch {
    return false
  }
}

/**
 * The origin reasoning both role guards need, kept in one place.
 *
 * Extracted rather than copied: the ORDER of these checks is the whole point —
 * see posNavigation — and two copies would eventually disagree about it.
 * `isAllowedPath` is the only thing that varies between roles.
 */
function navigationFor(url, appOrigin, isAllowedPath) {
  /* Origin not yet known — the app is still starting. Nothing can be judged
     foreign, so nothing may be sent to a browser: doing so would open the shop
     itself in Chrome, in a different profile with no session and no outbox.
     Refuse everything until startup has said where we live. */
  if (!appOrigin) return 'refuse'

  let sameOrigin = false
  try {
    sameOrigin = new URL(url).origin === appOrigin
  } catch {
    sameOrigin = false
  }

  if (sameOrigin) return isAllowedPath(url) ? 'allow' : 'refuse'

  /* Not ours, and not parseable as a web URL either — a javascript: or file:
     target has no business replacing the window, and must not be handed to the
     shell. Refuse rather than externalise. */
  try {
    const { protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return 'refuse'
  } catch {
    return 'refuse'
  }

  return 'external'
}

/**
 * What the database-setup build should do with a main-window navigation.
 *
 * Same three verdicts as the till, and the same reason for having them: this
 * build ships without a back office, so a link into one must not open a window
 * the machine has no business showing.
 */
function setupNavigation(url, appOrigin) {
  return navigationFor(url, appOrigin, isSetupPath)
}

/**
 * What the till build should do with a main-window navigation.
 *
 *   'allow'    — one of our own screens a till may show.
 *   'refuse'   — one of our own back-office screens. Refused outright rather
 *                than handed to a browser, which would open a signed-in back
 *                office from a machine whose whole point is that it has none.
 *   'external' — somebody else's site. Goes to the user's own browser, exactly
 *                as it does from the back office.
 *
 * ── ORIGIN FIRST, THEN PATH ───────────────────────────────────────────────
 *
 * The other order is a real hole: a link to somebody else's
 * https://supplier.example/pos matches isPosPath, and would navigate the till
 * window to a third-party site inside a shell with our preload attached.
 *
 * `appOrigin` is passed in rather than read from the window, because during
 * startup the window shows starting.html whose origin is the string 'null' —
 * against which our own app looks foreign, and a guard acting on that would
 * open the shop in the user's browser.
 */
function posNavigation(url, appOrigin) {
  return navigationFor(url, appOrigin, isPosPath)
}

/** Test seam. The role is decided once per process everywhere else. */
function resetForTests() {
  cached = null
}

module.exports = {
  appRole,
  isPos,
  isDatabaseSetup,
  startPath,
  isPosPath,
  posNavigation,
  isSetupPath,
  setupNavigation,
  resetForTests,
  ROLES,
  POS_ALLOWED_EXACT,
}

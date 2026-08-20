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
  return isPos() ? '/pos' : '/'
}

/** Test seam. The role is decided once per process everywhere else. */
function resetForTests() {
  cached = null
}

module.exports = { appRole, isPos, isDatabaseSetup, startPath, resetForTests, ROLES }

// Write electron/buildDefaults.json from the current environment.
//
// The packaged app has no .env — see electron/runtimeConfig.js. A CLOUD install
// gets its control-database connection and our shared secrets from this file,
// baked into the asar at build time. Without it the app starts and then throws
// on the first query, because src/lib/crypto/secrets.ts refuses to run without
// ENCRYPTION_KEY.
//
// Run with the env loaded, which the dist scripts already do:
//   node --env-file=.env scripts/make-build-defaults.mjs
//
// NEVER commit the output. It is in .gitignore, and it holds live credentials:
// anyone with the installer can extract them, which is why the server
// re-validates everything a client claims.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'electron', 'buildDefaults.json')

/* The Next app directory needs its own package.json beside the asar. It cannot
   be the repo's own file: electron-builder excludes every extraResources
   source from the asar, and the asar root is exactly where Electron looks for
   `main`. So it gets a copy from here instead. See electron-builder.yml. */
const APP_PKG = join(ROOT, 'build', 'app-package.json')

/* Exactly the keys resolveEnv() reads in its cloud branch, no more. Anything
   extra would be shipped to every customer for no reason. */
const KEYS = [
  /* Carried so the packaged app knows where its updates come from; see
     electron/updater.js and the `publish` block in electron-builder.yml. */
  'ODYSSEY_UPDATE_URL',
  /* The control panel, over HTTPS. These replace a direct MySQL connection to
     port 3306 that only ever worked from a whitelisted network — see
     electron/posApi.js for what they are and what they are not. */
  'POS_API_URL',
  'POS_API_CLIENT_ID',
  'POS_API_CLIENT_SECRET',
  /* Not for authenticating the call — for opening its ANSWER. Every credential
     the portal returns travels in a `pos:v1:` envelope sealed to this key. */
  'POS_API_PAYLOAD_KEY',
  /* ── NO DB_* ANY MORE ──────────────────────────────────────────────────────
   *
   * DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME used to be baked here so
   * a packaged install could open a MySQL socket to odyssey_tickets. They are
   * gone, and the removal is the point of the whole exercise:
   *
   *   · An asar unpacks in seconds. Those five values are the keys to the
   *     CONTROL database — every shop on the platform, not just the one that
   *     downloaded the installer.
   *   · Nothing used them. The connection only ever worked from a whitelisted
   *     network, so on a shop's line every such read failed silently and the
   *     machine degraded instead. The portal clients under lib/control/ answer
   *     the same questions over signed HTTPS.
   *
   * pool() in src/lib/db.ts now refuses to open that socket on desktop at all,
   * so a call site that is added later fails loudly in testing rather than
   * quietly shipping a credential requirement back into the build.
   *
   * Verified before removal, on a full session with the line up and with it
   * down: zero statements to the ticketing database either way.
   *
   * ── AND WHY THESE TWO STAY ────────────────────────────────────────────────
   *
   * Neither is a connection to anything.
   *
   *   SESSION_SECRET  signs this install's own session cookies.
   *   ENCRYPTION_KEY  opens the `enc:v1:` credentials this machine legitimately
   *                   holds — its own site database password among them.
   *
   * Extracting them buys an attacker access to the machine they are already
   * sitting at. Extracting DB_PASSWORD bought them everybody else's shop, which
   * is the difference that mattered. */
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
]

/* The update URL is allowed to be absent — a build without one still runs, it
   just cannot update itself, and the warning above says so. Everything else is
   load-bearing. */
const OPTIONAL = new Set(['ODYSSEY_UPDATE_URL'])
const REQUIRED = KEYS.filter((k) => !OPTIONAL.has(k))
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`buildDefaults: missing ${missing.join(', ')}`)
  console.error('Run with --env-file=.env, or set them in the shell.')
  process.exit(1)
}

const defaults = Object.fromEntries(
  KEYS.filter((k) => process.env[k]).map((k) => [k, String(process.env[k])]),
)
writeFileSync(OUT, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')

/* Say what was written without printing the values — this runs in terminals
   that get pasted into chats. */
/* ── THE UPDATE FEED IS A BUILD FACT, NOT A RUNTIME ONE ─────────────────────
   A packaged app has no .env, so the URL has to travel with it. Warned about
   rather than defaulted: a build that silently cannot update is the failure
   this whole feature exists to prevent, and it would look identical to one
   that simply had no release yet. */
if (!process.env.ODYSSEY_UPDATE_URL) {
  console.warn('buildDefaults: ODYSSEY_UPDATE_URL is not set — this build will NEVER auto-update.')
}

console.log(`buildDefaults: wrote ${KEYS.length} keys to electron/buildDefaults.json`)
/* The portal URL, because that is the one value a builder gets wrong and the
   one whose being wrong is invisible until a shop cannot renew its licence.
   No DB_HOST any more — this build carries no database connection at all. */
console.log(`  POS_API_URL=${defaults.POS_API_URL}  (secrets not shown)`)

mkdirSync(dirname(APP_PKG), { recursive: true })
copyFileSync(join(ROOT, 'package.json'), APP_PKG)
console.log('buildDefaults: staged build/app-package.json for the Next app dir')

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
  'POS_API_PAYLOAD_KEY',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
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
console.log(`  DB_HOST=${defaults.DB_HOST}  DB_NAME=${defaults.DB_NAME}  (secrets not shown)`)

mkdirSync(dirname(APP_PKG), { recursive: true })
copyFileSync(join(ROOT, 'package.json'), APP_PKG)
console.log('buildDefaults: staged build/app-package.json for the Next app dir')

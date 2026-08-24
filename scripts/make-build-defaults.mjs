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
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
]

const missing = KEYS.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`buildDefaults: missing ${missing.join(', ')}`)
  console.error('Run with --env-file=.env, or set them in the shell.')
  process.exit(1)
}

const defaults = Object.fromEntries(KEYS.map((k) => [k, String(process.env[k])]))
writeFileSync(OUT, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')

/* Say what was written without printing the values — this runs in terminals
   that get pasted into chats. */
console.log(`buildDefaults: wrote ${KEYS.length} keys to electron/buildDefaults.json`)
console.log(`  DB_HOST=${defaults.DB_HOST}  DB_NAME=${defaults.DB_NAME}  (secrets not shown)`)

mkdirSync(dirname(APP_PKG), { recursive: true })
copyFileSync(join(ROOT, 'package.json'), APP_PKG)
console.log('buildDefaults: staged build/app-package.json for the Next app dir')

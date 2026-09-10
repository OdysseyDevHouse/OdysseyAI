/**
 * Give `npm run dev:desktop` the site signing key a real install already has.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A packaged desktop build does not open a control-database socket. `pool()` in
 * lib/db.ts refuses, deliberately and loudly, and every screen that needs
 * odyssey_tickets — Setup → Staff and permissions, Billing, Tills — asks the
 * POS API instead. What lets it ask is a per-site key: ODYSSEY_SITE_API_KEY and
 * ODYSSEY_SITE_API_KEY_ID, which runtimeConfig.js unseals out of the machine
 * config and publishes into the server's environment on start.
 *
 * In dev there is no such publishing. Next runs as a SEPARATE process from
 * Electron — that is the whole reason .env.local exists — so a key sealed in
 * ProgramData reaches nothing, portalConfig() returns null, every portal client
 * answers "ask the database yourself", and the fallback throws. The screen dies
 * with "This build does not connect to the control database", which is the
 * correct message for the wrong reason: the route exists and answers, this
 * process simply had no key to sign with.
 *
 * So: sign in once, take the key the portal hands out for the store dev is
 * pointed at, and write it into .env.local beside the database credentials that
 * are already there. The same two lines runtimeConfig sets in a packaged build.
 *
 * ── WHY IT SIGNS IN RATHER THAN READING ProgramData ─────────────────────────
 *
 * ProgramData\Odyssey\site.json is written by Odyssey Database Setup, and it
 * only carries apiKey/apiKeyId if Setup was new enough to collect one. A
 * machine set up before the portal issued keys has a site.json with no key in
 * it at all and nothing to copy — which is exactly the machine this script is
 * for. /login is where the key comes from in the first place.
 *
 * ── RUN ─────────────────────────────────────────────────────────────────────
 *
 *   npm run dev:key
 *
 * Credentials come from DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local, and
 * the store from ODYSSEY_SITE_ID there. Override either:
 *
 *   node --env-file=.env scripts/dev-site-key.mjs --login you@x.co.za "pw" --site 4
 *
 * The key is never printed. It is a shop credential, and a terminal scrollback
 * is not where one belongs.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_LOCAL = path.join(ROOT, '.env.local')

/* ── .env.local is read HERE rather than by --env-file ───────────────────────
 *
 * Two reasons. It may not exist yet on a fresh checkout, and --env-file on a
 * missing file is a hard error before this script can say anything useful. And
 * the file has to be rewritten anyway, so it is parsed once and edited in
 * place — every other line kept exactly as the person wrote it, comments
 * included. A generator that reformats a hand-maintained file is a generator
 * nobody runs twice.
 */
function readEnvLocal() {
  try {
    return fs.readFileSync(ENV_LOCAL, 'utf8')
  } catch {
    return ''
  }
}

function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** Replace a variable if it is already there, append it if it is not. */
function upsert(text, name, value) {
  const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, `${name}=${value}`)
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${body}${name}=${value}\n`
}

/* Identical to normaliseUrl in lib/control/portalApi.ts and electron/posApi.js:
   one value configures all three, so all three have to accept the same forms. */
function normaliseUrl(value) {
  let url = String(value || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!/\/api\/pos\/v\d+$/i.test(url)) url = `${url}/api/pos/v1`
  return url
}

const args = process.argv.slice(2)
function flag(name, count = 1) {
  const at = args.indexOf(name)
  if (at === -1) return null
  return count === 1 ? args[at + 1] ?? null : args.slice(at + 1, at + 1 + count)
}

const fileText = readEnvLocal()
const local = parseEnv(fileText)

const BASE = normaliseUrl(process.env.POS_API_URL)
const CLIENT_ID = (process.env.POS_API_CLIENT_ID || '').trim()
const CLIENT_SECRET = (process.env.POS_API_CLIENT_SECRET || '').trim()
const PAYLOAD_KEY = (process.env.POS_API_PAYLOAD_KEY || '').trim()

const login = flag('--login', 2)
const email = (login?.[0] || local.DEV_LOGIN_EMAIL || '').trim()
const password = login?.[1] || local.DEV_LOGIN_PASSWORD || ''
const wantedSite = Number(flag('--site') || local.ODYSSEY_SITE_ID || 0)

console.log('\nDev site key — the two lines a packaged build gets from runtimeConfig\n')
console.log(`  portal  ${BASE}`)
console.log(`  file    ${ENV_LOCAL}`)

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n  POS_API_CLIENT_ID / POS_API_CLIENT_SECRET are not set. Run this through npm run dev:key.\n')
  process.exit(1)
}
if (!email || !password) {
  console.error(
    '\n  No sign-in. Put DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local,' +
      ' or pass --login <email> <password>.\n',
  )
  process.exit(1)
}

/* ── The sign-in ─────────────────────────────────────────────────────────────
 *
 * The same call OdysseyAI Database Setup makes, with the same client
 * credentials. deviceSerial names this checkout so a key issued to a developer
 * machine is identifiable in the portal's own records rather than looking like
 * a till.
 */
let payload
try {
  const response = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Client-Id': CLIENT_ID,
      'X-Api-Client-Secret': CLIENT_SECRET,
    },
    body: JSON.stringify({ email, password, deviceSerial: 'odyssey-dev-desktop' }),
    signal: AbortSignal.timeout(Number(process.env.PORTAL_API_TIMEOUT_MS || 8000)),
  })
  payload = await response.json().catch(() => null)
  if (!response.ok) {
    console.error(
      `\n  Sign-in refused (${response.status}): ${payload?.message || payload?.error || 'no message'}\n`,
    )
    process.exit(1)
  }
} catch (err) {
  console.error(`\n  The portal could not be reached — ${err?.message || err}\n`)
  process.exit(1)
}

const stores = payload?.stores || payload?.sites || []
if (!Array.isArray(stores) || !stores.length) {
  console.error('\n  That sign-in opens no stores, so there is no key to take.\n')
  process.exit(1)
}

const store = wantedSite ? stores.find((s) => Number(s.siteId ?? s.id) === wantedSite) : stores[0]
if (!store) {
  console.error(
    `\n  Site ${wantedSite} is not one this account opens. It opens: ` +
      `${stores.map((s) => `${s.siteId ?? s.id} (${s.name ?? s.tradingName ?? '?'})`).join(', ')}\n` +
      '  Point ODYSSEY_SITE_ID at one of those, or pass --site.\n',
  )
  process.exit(1)
}

const siteId = Number(store.siteId ?? store.id)
const keyId = String(store.apiKeyId ?? store.keyId ?? payload.keyId ?? '')
let key = String(store.apiKey ?? store.key ?? payload.apiKey ?? '')

/* The portal may hand the key over sealed with the build's payload key — the
   same envelope electron/posApi.js opens. Unsealed here because .env.local is
   read by a Next process that has no opener. */
if (key.startsWith('pos:v1:')) {
  const opener = Buffer.from(PAYLOAD_KEY, 'base64')
  if (opener.length !== 32) {
    console.error(`\n  The key arrived sealed and POS_API_PAYLOAD_KEY is ${opener.length} bytes, not 32.\n`)
    process.exit(1)
  }
  const [iv, tag, ciphertext] = key.slice('pos:v1:'.length).split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', opener, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  key = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

if (!key || !keyId) {
  console.error(
    '\n  The sign-in carried no site key. Nothing here can invent one, and the\n' +
      '  desktop screens that need the portal stay dark until it issues one.\n',
  )
  process.exit(1)
}

let next = fileText
next = upsert(next, 'ODYSSEY_SITE_ID', String(siteId))
next = upsert(next, 'ODYSSEY_SITE_API_KEY', key)
next = upsert(next, 'ODYSSEY_SITE_API_KEY_ID', keyId)
fs.writeFileSync(ENV_LOCAL, next, 'utf8')

console.log(`\n  Written for site ${siteId} — ${store.name ?? store.tradingName ?? '?'}`)
console.log('  ODYSSEY_SITE_API_KEY, ODYSSEY_SITE_API_KEY_ID (values not shown)')
console.log('\n  Restart npm run dev:desktop — Next reads .env.local once, at boot.\n')

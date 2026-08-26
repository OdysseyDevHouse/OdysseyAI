/**
 * The POS API client — against the real control panel.
 *
 * ── WHY THIS ONE TALKS TO PRODUCTION ────────────────────────────────────────
 *
 * Because the thing worth testing is the contract, and a stub would only prove
 * that this file agrees with itself. The API's own `/ping` exists precisely so
 * an integrator can check their keys before they have a customer to test with,
 * and it reads nothing and writes nothing.
 *
 * `--login <email> <password>` additionally exercises a real sign-in, which is
 * the only way to see a real envelope. Left out by default: sign-ins are logged
 * and rate limited, and a test suite is not a reason to consume either.
 *
 *   node --env-file=.env scripts/test-pos-api.mjs
 *   node --env-file=.env scripts/test-pos-api.mjs --login you@example.co.za 'password'
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const posApi = require(path.join(here, '..', 'electron', 'posApi.js'))

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nPOS API\n')

/* ── The URL, in whatever form somebody configured it ─────────────────────── */

const original = process.env.POS_API_URL
for (const [given, expected] of [
  ['portal.example.co.za', 'https://portal.example.co.za/api/pos/v1'],
  ['https://portal.example.co.za', 'https://portal.example.co.za/api/pos/v1'],
  ['https://portal.example.co.za/', 'https://portal.example.co.za/api/pos/v1'],
  ['https://portal.example.co.za/api/pos/v1', 'https://portal.example.co.za/api/pos/v1'],
  ['http://portal.example.co.za/api/pos/v1', 'http://portal.example.co.za/api/pos/v1'],
]) {
  process.env.POS_API_URL = given
  check(`"${given}" resolves`, posApi.baseUrl() === expected, posApi.baseUrl())
}
/* A missing scheme becomes https, never http: there is no version of this call
   that should carry a password in the clear. */
process.env.POS_API_URL = 'portal.example.co.za'
check('a bare host is assumed to be https', posApi.baseUrl().startsWith('https://'))
process.env.POS_API_URL = original

/* ── The envelope ─────────────────────────────────────────────────────────── */

const key = Buffer.from(process.env.POS_API_PAYLOAD_KEY || '', 'base64')
check('the payload key is 32 bytes', key.length === 32, `${key.length} bytes`)

if (key.length === 32) {
  /* Sealed here exactly as the server seals it, so a round trip proves the
     format rather than proving this file can read its own output. */
  const seal = (plain) => {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return `pos:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`
  }

  check('a sealed password round-trips', posApi.openEnvelope(seal('hunter2!@#')) === 'hunter2!@#')
  check('an empty password round-trips', posApi.openEnvelope(seal('')) === '')

  /* The tag check is the whole point. Without it a tampered value comes back as
     a corrupted password, gets handed to MariaDB, and looks like the customer's
     fault. */
  const good = seal('correct-horse')
  const [, , iv, tag, ct] = good.split(':')
  const flipped = Buffer.from(ct, 'base64')
  flipped[0] ^= 0x01
  let threw = false
  try {
    posApi.openEnvelope(`pos:v1:${iv}:${tag}:${flipped.toString('base64')}`)
  } catch {
    threw = true
  }
  check('a tampered ciphertext throws rather than returning rubbish', threw)

  let badTag = false
  try {
    posApi.openEnvelope(`pos:v1:${iv}:${Buffer.alloc(16).toString('base64')}:${ct}`)
  } catch {
    badTag = true
  }
  check('a wrong auth tag throws', badTag)

  for (const bad of ['', 'nonsense', 'pos:v2:a:b:c', 'pos:v1:only:two']) {
    let rejected = false
    try {
      posApi.openEnvelope(bad)
    } catch {
      rejected = true
    }
    check(`"${bad.slice(0, 18) || '(empty)'}" is rejected`, rejected)
  }
}

/* ── The real server ──────────────────────────────────────────────────────── */

try {
  const pong = await posApi.ping()
  check('ping answers', pong?.ok === true)
  console.log(`        client: ${pong?.client}`)
} catch (err) {
  check('ping answers', false, err.message)
}

/* ── An actual sign-in, only when asked ───────────────────────────────────── */

const i = process.argv.indexOf('--login')
if (i !== -1) {
  const email = process.argv[i + 1]
  const password = process.argv[i + 2]
  try {
    const payload = await posApi.login(email, password, 'test-suite')
    check('login answers', !!payload?.user)
    console.log(`        ${payload.stores?.length ?? 0} store(s) for ${payload.user?.email}`)
    for (const s of payload.stores || []) {
      const db = posApi.databaseFor(s, 'master')
      console.log(`        ${s.siteCode} ${s.tradingName || s.companyName} — ${s.connectionType}, accessible=${s.isAccessible}`)
      if (db) {
        const pw = db.password ? posApi.openEnvelope(db.password) : null
        console.log(
          `           master: ${db.dbUsername}@${db.serverHost}:${db.serverPort}/${db.databaseName} ` +
            `password=${pw ? `${pw.length} chars` : db.passwordError || 'none'}`,
        )
      } else {
        console.log('           no active master database')
      }
      const live = (s.modules || []).filter((m) => m.isLive).map((m) => m.key)
      console.log(`           live modules: ${live.join(', ') || '(none)'}`)
    }
  } catch (err) {
    check('login answers', false, err.message)
  }
}

console.log(`\n${failures === 0 ? 'All POS API checks passed.' : `${failures} FAILED`}\n`)
/* exitCode rather than exit(): Node on Windows trips a libuv assertion when the
   process is torn down with fetch's keep-alive sockets still open. Harmless, but
   it prints after the summary and reads exactly like a crash. */
process.exitCode = failures === 0 ? 0 : 1

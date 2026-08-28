/**
 * The signature this app puts on an unattended call to the control panel.
 *
 * ── WHY THIS IS PINNED LITERALLY ────────────────────────────────────────────
 *
 * The other end computes the same value in a different repository, from the
 * four lines written down in the portal's POS_API.md §6.2. Nothing links the
 * two implementations — no shared package, no generated client — so the only
 * thing keeping them in step is that both are asserted against the spec.
 *
 * If they ever drift by one character, every signed call from every shop fails
 * at once, and it fails as `invalid_site_signature`, which is deliberately
 * opaque and says nothing about what went wrong. That is a very bad afternoon
 * to debug, and it is entirely preventable here.
 *
 * The expected values below are built with node's crypto directly, from the
 * documented recipe, rather than by calling the code under test — otherwise
 * this asserts only that the function agrees with itself.
 *
 *   npx tsx --conditions=react-server scripts/test-portal-signing.ts
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { signingString, signatureFor } from '../src/lib/control/portalApi'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const KEY = randomBytes(32).toString('base64')
const OTHER = randomBytes(32).toString('base64')
const TS = '2026-08-27T09:14:22.104Z'
const PATH = '/api/pos/v1/licence/check'
const BODY = JSON.stringify({ serial: 'SN-44821' })

/** The spec, written out independently of the implementation. */
function expectedSignature(key: string, method: string, path: string, ts: string, raw: string): string {
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
  const line = `${method.toUpperCase()}\n${path}\n${ts}\n${digest}`
  return createHmac('sha256', Buffer.from(key, 'base64')).update(line, 'utf8').digest('base64')
}

console.log('\nThe signing string is the documented four lines, in order')
const lines = signingString('POST', PATH, TS, BODY).split('\n')
check('exactly four lines', lines.length === 4, String(lines.length))
check('1: the method, upper-cased', lines[0] === 'POST')
check('2: the full path the request is sent to', lines[1] === PATH)
check('3: the timestamp, character for character', lines[2] === TS)
check('4: the lower-case hex SHA-256 of the body', lines[3] === createHash('sha256').update(BODY, 'utf8').digest('hex'))

console.log('\nIt matches the spec, computed independently')
check(
  'a POST with a body',
  signatureFor(KEY, 'POST', PATH, TS, BODY) === expectedSignature(KEY, 'POST', PATH, TS, BODY),
)
check(
  'a GET with no body signs the empty string',
  signatureFor(KEY, 'GET', '/api/pos/v1/licence/spots', TS, '') ===
    expectedSignature(KEY, 'GET', '/api/pos/v1/licence/spots', TS, ''),
)
check('the output is 32 bytes of HMAC-SHA256', Buffer.from(signatureFor(KEY, 'POST', PATH, TS, BODY), 'base64').length === 32)

console.log('\nEverything that must change the signature does')
const base = signatureFor(KEY, 'POST', PATH, TS, BODY)
check('a different key', signatureFor(OTHER, 'POST', PATH, TS, BODY) !== base)
check('a different method', signatureFor(KEY, 'GET', PATH, TS, BODY) !== base)
check(
  'a different path — this is what stops /check opening /release',
  signatureFor(KEY, 'POST', '/api/pos/v1/licence/release', TS, BODY) !== base,
)
check('a different timestamp', signatureFor(KEY, 'POST', PATH, '2026-08-27T09:15:22.104Z', BODY) !== base)
check('a different body', signatureFor(KEY, 'POST', PATH, TS, JSON.stringify({ serial: 'OTHER' })) !== base)

console.log('\nAnd the things that must not')
check('a lower-case method still verifies', signatureFor(KEY, 'post', PATH, TS, BODY) === base)

console.log('\nThe body is hashed, not concatenated')
// A body carrying a newline must not be able to forge a fifth line, and a large
// body must not make the signing string grow without bound.
const sneaky = JSON.stringify({ label: 'x\n/api/pos/v1/licence/release' })
check('a newline in the body cannot forge a line', signingString('POST', PATH, TS, sneaky).split('\n').length === 4)
const huge = signingString('POST', PATH, TS, 'x'.repeat(100_000))
check('a 100KB body still signs a short string', huge.length < 200, String(huge.length))

console.log('\nUnicode is hashed as UTF-8, not the platform default')
const unicode = JSON.stringify({ label: 'Café — Till 2' })
check(
  'an accented label matches the spec',
  signatureFor(KEY, 'POST', PATH, TS, unicode) === expectedSignature(KEY, 'POST', PATH, TS, unicode),
)

console.log(failures === 0 ? '\nAll portal-signing checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

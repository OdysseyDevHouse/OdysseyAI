/**
 * TOTP — the RFC 6238 test vectors, and the guards around them.
 *
 * The vectors are the whole point: a hand-rolled HMAC truncation that
 * produces the RFC's own published codes is correct by definition, and one
 * that does not is wrong however plausible it looks.
 *
 *   npm run test:totp
 */
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  otpauthUri,
} from '../src/lib/totp'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

// The RFC 6238 SHA-1 test secret: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

// (time seconds, 6 rightmost digits of the RFC's 8-digit vectors)
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
]

for (const [seconds, expected] of VECTORS) {
  ok(`*** RFC vector t=${seconds} → ${expected} ***`,
    totpCode(RFC_SECRET, { atMs: seconds * 1000 }) === expected,
    totpCode(RFC_SECRET, { atMs: seconds * 1000 }))
}

/* ── base32 round-trips, including non-multiple-of-5 lengths ─────────────── */

for (const len of [1, 2, 3, 4, 5, 7, 10, 19, 20, 33]) {
  const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff))
  ok(`base32 round-trips ${len} bytes`, base32Decode(base32Encode(buf)).equals(buf))
}
ok('lower-case and spaced input decode too',
  base32Decode('gezd gnbv').equals(base32Decode('GEZDGNBV')))
ok('junk is refused, not guessed', (() => {
  try { base32Decode('AB1!') ; return false } catch { return true }
})())

/* ── The verify window ───────────────────────────────────────────────────── */

const at = 1_700_000_000_000
const now = totpCode(RFC_SECRET, { atMs: at })
const prev = totpCode(RFC_SECRET, { atMs: at - 30_000 })
const next = totpCode(RFC_SECRET, { atMs: at + 30_000 })
const far = totpCode(RFC_SECRET, { atMs: at + 90_000 })

ok('*** the current code verifies ***', verifyTotp(RFC_SECRET, now, { atMs: at }).ok)
ok('  the previous step passes — clocks drift', verifyTotp(RFC_SECRET, prev, { atMs: at }).ok)
ok('  the next step passes too', verifyTotp(RFC_SECRET, next, { atMs: at }).ok)
ok('  two steps out is refused', !verifyTotp(RFC_SECRET, far, { atMs: at }).ok)
ok('  garbage is refused', !verifyTotp(RFC_SECRET, 'abcdef', { atMs: at }).ok)
ok('  the wrong length is refused', !verifyTotp(RFC_SECRET, '12345', { atMs: at }).ok)

const match = verifyTotp(RFC_SECRET, prev, { atMs: at })
ok('*** the MATCHED step is returned, for the replay guard ***',
  match.ok && match.step === Math.floor(at / 1000 / 30) - 1)

/* ── Secrets and URIs ────────────────────────────────────────────────────── */

const secret = generateTotpSecret()
ok('a generated secret is 32 base32 chars', /^[A-Z2-7]{32}$/.test(secret))
ok('  and two are never the same', generateTotpSecret() !== secret)

const uri = otpauthUri({ secret, accountName: 'jan@shop.co.za', issuer: 'My Café & Co' })
ok('the otpauth URI carries the secret verbatim', uri.includes(`secret=${secret}`))
ok('  and percent-encodes the issuer', uri.includes('My%20Caf%C3%A9%20%26%20Co'))
ok('  in both the label and the parameter',
  uri.startsWith('otpauth://totp/My%20Caf%C3%A9%20%26%20Co:jan%40shop.co.za?'))

console.log(fails === 0 ? '\nAll TOTP checks passed.' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)

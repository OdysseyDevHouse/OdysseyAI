import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * TOTP (RFC 6238) on plain node crypto — no dependency, because a one-time
 * code is forty lines of HMAC and a dependency is an audit surface.
 *
 * SHA-1, 6 digits, 30-second steps: the parameters every authenticator app
 * defaults to, and the ones the RFC test vectors prove below in test-totp.
 * No `server-only`, deliberately, so the pure tests can import it — the
 * SECRETS never live here; they arrive base32-decoded from the caller.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, no padding — the form every authenticator accepts typed. */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch)
    if (index === -1) throw new Error(`Not base32: "${ch}"`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 20 random bytes → 32 base32 chars, the size Google Authenticator ships. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

/** The RFC 4226 dynamic truncation over one counter value. */
function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8)
  // A 30-second step counter stays far below 2^53, so two 32-bit writes hold it.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  msg.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac('sha1', key).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code =
    (((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff)) %
    10 ** digits
  return String(code).padStart(digits, '0')
}

export function totpCode(
  secretBase32: string,
  opts: { atMs?: number; stepSeconds?: number; digits?: number } = {},
): string {
  const step = Math.floor((opts.atMs ?? Date.now()) / 1000 / (opts.stepSeconds ?? 30))
  return hotp(base32Decode(secretBase32), step, opts.digits ?? 6)
}

/**
 * Verifies within ±window steps (default 1 — clocks drift, phones lag).
 * Returns the MATCHED step so the caller can refuse replays: a code is
 * single-use, and "which step did it come from" is what makes that checkable.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { atMs?: number; window?: number; stepSeconds?: number; digits?: number } = {},
): { ok: true; step: number } | { ok: false } {
  const digits = opts.digits ?? 6
  const typed = code.replace(/\s/g, '')
  if (!/^\d+$/.test(typed) || typed.length !== digits) return { ok: false }

  const key = base32Decode(secretBase32)
  const now = Math.floor((opts.atMs ?? Date.now()) / 1000 / (opts.stepSeconds ?? 30))
  const window = Math.max(0, Math.floor(opts.window ?? 1))

  for (let delta = -window; delta <= window; delta++) {
    const step = now + delta
    if (step < 0) continue
    const expected = hotp(key, step, digits)
    // Constant time, so the comparison cannot leak which digits matched.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) {
      return { ok: true, step }
    }
  }
  return { ok: false }
}

/** The provisioning URI an authenticator app reads, typed or scanned. */
export function otpauthUri(o: { secret: string; accountName: string; issuer?: string }): string {
  const issuer = o.issuer ?? 'OdysseyAI'
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(o.accountName)}`
  return `otpauth://totp/${label}?secret=${o.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

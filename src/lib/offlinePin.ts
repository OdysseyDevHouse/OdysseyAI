/**
 * Checking a till PIN with no server.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 *
 * `signInWithPin` bcrypt-compares against `users.pin_hash` in the database. A till
 * that cannot reach the database still has to know who is standing at it, or the
 * shop cannot trade and no sale can be attributed to anybody.
 *
 * ── WHAT WAS REJECTED ─────────────────────────────────────────────────────
 *
 * SHIPPING THE BCRYPT HASHES. bcryptjs does run in a browser, so it works
 * mechanically. But PINs are four to six digits and the cost is 10: ten thousand
 * hashes breaks a 4-digit PIN, which is seconds on a laptop — and the attacker
 * gets the hash by opening DevTools on the till. It would also hand over every
 * manager's supervisor-override PIN at once.
 *
 * A PLAIN SHA-256 of the PIN. Faster to break, not slower. Ten thousand unsalted
 * SHA-256s is microseconds.
 *
 * ── WHAT THIS DOES INSTEAD ────────────────────────────────────────────────
 *
 *     verifier = PBKDF2-SHA256(
 *                  password = pin,
 *                  salt     = HMAC-SHA256(OFFLINE_PIN_KEY, site|user|device),
 *                  iters    = 2_400_000 )
 *
 * Three properties, and each closes a different attack:
 *
 *   · The SALT is an HMAC under a server secret that never leaves the server. An
 *     attacker who dumps IndexedDB cannot even construct the salt, so the verifier
 *     is not attackable on its own.
 *   · The salt binds the DEVICE. Copying the local database to another machine
 *     yields verifiers that verify nothing.
 *   · The COST makes a brute force slow even for somebody holding the secret.
 *
 * ── WHY 2.4M AND NOT 600k ─────────────────────────────────────────────────
 *
 * 600k was the first figure here, chosen on the assumption it cost ~300-600ms per
 * attempt. Measured on real hardware it costs 59ms — so a 4-digit PIN would fall
 * in about twelve minutes, not the hour the design intended. Measured again across
 * a range:
 *
 *     600k    59ms   4-digit ~0.2h    6-digit ~1 day
 *   1,200k   119ms   4-digit ~0.3h    6-digit ~1 day
 *   2,400k   242ms   4-digit ~0.7h    6-digit ~3 days
 *   4,800k   483ms   4-digit ~1.3h    6-digit ~6 days
 *
 * 2.4M is the knee: a quarter of a second is still imperceptible when a cashier
 * has just finished pressing four keys, and it restores the intended cost. Do not
 * lower it without re-measuring — and note the count is STORED with each verifier,
 * so raising it later does not invalidate existing PINs.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *
 * Not as strong as a server check, and it is not pretending to be. Somebody who
 * steals a till AND extracts the secret can brute-force a 4-digit PIN in under an
 * hour. That is why `users.pinInUse` already forbids repeated and sequential
 * digits, why the till rate-limits attempts locally, and why anyone holding
 * `sales.void` or an override capability should be on a 6-digit PIN — a million
 * candidates is about three days at this cost, against forty minutes for four
 * digits. The difference between 4 and 6 digits is worth more here than any
 * further increase in iterations.
 *
 * ── WHY IT LIVES HERE ─────────────────────────────────────────────────────
 *
 * No `server-only`, no Node imports: it is WebCrypto and nothing else, so the
 * identical code runs in the browser and under `tsx` in a test. That is not a
 * convenience — a crypto function that cannot be tested without a browser does
 * not get tested.
 */

/* Measured, not guessed — see the table in the module comment. 242ms per attempt
   on the hardware this was written on. */
const ITERATIONS = 2_400_000
const KEY_BITS = 256

/** WebCrypto, from wherever this is running. Node 20+ exposes the same API. */
function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error('WebCrypto is not available — an offline PIN cannot be checked here.')
  }
  return c.subtle
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // btoa exists in browsers and in Node 16+.
  return btoa(binary)
}

/**
 * Returns an ArrayBuffer rather than a Uint8Array.
 *
 * WebCrypto's `BufferSource` will not accept a `Uint8Array<ArrayBufferLike>`,
 * which is what the view's default generic resolves to — handing back the buffer
 * itself sidesteps the mismatch without a cast that would hide a real error later.
 */
function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out.buffer
}

/**
 * The salt for one operator on one device.
 *
 * SERVER-SIDE ONLY in practice — it needs `OFFLINE_PIN_KEY`, which the browser
 * never sees. It is here rather than in the server module so the derivation and
 * its verification are one readable pair, and so a test can exercise both.
 *
 * The three fields are joined with a separator that cannot appear in any of them
 * (they are numbers and a uuid), so no two different triples can produce the same
 * salt string by concatenation.
 */
export async function verifierSalt(
  secret: string,
  siteId: number,
  userId: number,
  deviceId: string,
): Promise<string> {
  if (!secret) throw new Error('OFFLINE_PIN_KEY is not set.')
  const key = await subtle().importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = new TextEncoder().encode(`${siteId}|${userId}|${deviceId}`)
  const mac = await subtle().sign('HMAC', key, message)
  return toBase64(new Uint8Array(mac))
}

/**
 * The verifier for a PIN under a given salt.
 *
 * Deterministic: the same inputs always produce the same string, which is what
 * lets it be compared rather than re-derived-and-guessed.
 */
export async function deriveVerifier(
  pin: string,
  saltB64: string,
  iterations = ITERATIONS,
): Promise<string> {
  const key = await subtle().importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: fromBase64(saltB64), iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return toBase64(new Uint8Array(bits))
}

/**
 * Constant-time comparison.
 *
 * A `===` on the two strings would return early at the first differing character,
 * and the timing of that leaks how much of a guess was right — which is enough to
 * find a verifier one character at a time. Length is compared first because it is
 * not secret; the bytes are then compared in full regardless of what differs.
 */
export function verifierMatches(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The iteration count new verifiers are minted at. */
export const VERIFIER_ITERATIONS = ITERATIONS

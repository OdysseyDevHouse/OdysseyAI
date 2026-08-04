import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * AES-256-GCM envelope for credentials we must read back — currently
 * cp2_site_databases.db_password_enc, the connection details for a customer's
 * own database server.
 *
 * This scheme is NOT ours to choose: it must match the v2 backend's
 * utils/secret.ts byte for byte, because that is what wrote the stored values.
 *   Algorithm : aes-256-gcm
 *   Key       : scryptSync(ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
 *   IV        : 12 random bytes per value
 *   Format    : enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>
 *
 * ENCRYPTION_KEY must be the SAME value as that backend's .env. A different
 * key does not fail cleanly at connect time — GCM authentication fails on
 * decrypt, which surfaces here as "could not be decrypted".
 *
 * This is only for reversible secrets. Sign-in passwords in cp2_users are
 * bcrypt and deliberately one-way — see password.ts. Never try to route those
 * through here.
 */

const PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const SALT = 'odyssey-secret-v1' // fixed salt; the env var is the actual secret
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'ENCRYPTION_KEY is not configured — required to read site database credentials. ' +
        'It must match the v2 backend .env exactly.',
    )
  }
  // Not trimmed: scrypt is over the raw bytes, and the backend derives from the
  // value verbatim. Trimming here would silently produce a different key.
  return scryptSync(raw, SALT, KEY_BYTES)
}

/** True when an ENCRYPTION_KEY is present — for setup screens to check. */
export function encryptionKeyConfigured(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plain: string): string {
  if (plain === '') return ''
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return (
    PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join(':')
  )
}

/**
 * Decrypts an enc:v1 value.
 *
 * Anything without the prefix is returned unchanged — legacy rows stored their
 * password in plaintext, and those must keep working rather than throw.
 */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored

  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) {
    throw new Error('Stored secret is malformed (expected iv:tag:ciphertext).')
  }

  const [iv, tag, ct] = parts.map((s) => Buffer.from(s, 'base64'))
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Stored secret is malformed (bad iv/tag length).')
  }

  const decipher = createDecipheriv(ALGO, key(), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    // GCM auth failure — wrong ENCRYPTION_KEY, or the ciphertext was altered.
    throw new Error(
      'Stored secret could not be decrypted — ENCRYPTION_KEY may not match the backend that wrote it.',
    )
  }
}

/**
 * Decrypt without throwing, for read paths that must degrade rather than fail
 * (a status screen showing "not connected" instead of 500-ing because the key
 * is wrong). Returns null where decryptSecret throws.
 */
export function tryDecryptSecret(stored: string | null): string | null {
  if (stored === null || stored === undefined) return null
  try {
    return decryptSecret(stored)
  } catch {
    return null
  }
}

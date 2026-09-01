// Shared by the scripts/check-* diagnostics, which all open the same control
// database connection.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// DB_PASSWORD may be an `enc:v1:` envelope rather than a plaintext password.
// The v2 backend keeps it that way in its own .env and decrypts on the way to
// MySQL, and a .env copied from that backend - the obvious thing to do, since
// both connect to the SAME odyssey_tickets - carries the ciphertext. The app
// handles it (src/lib/db.ts createPool); a script that reads the variable raw
// sends the ciphertext as the password and gets
//
//     Access denied for user 'X'@'host' (using password: YES)
//
// which reads as a wrong password or a missing grant and is neither. Every one
// of these scripts had that bug, so the fix lives in one place.
//
// The migration runners deliberately do NOT import this: tickets-migrate.mjs,
// site-migrate.mjs and box-migrate.mjs also run from the deployed app folder,
// which ships those three files and no others, so each carries its own copy.
import { createDecipheriv, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'

/** Mirrors src/lib/crypto/secrets.ts. Plaintext passes through unchanged. */
export function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

import 'server-only'
import { createDecipheriv } from 'node:crypto'

/**
 * Opening a `pos:v1:` envelope — the form credentials travel in from the POS
 * API.
 *
 * ── WHY THE NEXT SERVER NEEDS ITS OWN COPY ──────────────────────────────────
 *
 * electron/posApi.js has opened these since the setup wizard shipped, and it is
 * the same twelve lines. It cannot be shared: that file is CommonJS in the
 * Electron main process, and this runs inside the Next server. The alternative
 * — routing every credential through IPC — would put a second hop, and a second
 * place to get it wrong, in front of a database connection.
 *
 * So it is duplicated, deliberately and once. If the envelope format ever
 * changes, both sides change; the format is versioned in the prefix precisely
 * so that day is loud rather than quiet.
 *
 * ── THE AUTH TAG IS VERIFIED, NOT MERELY PRESENT ────────────────────────────
 *
 * AES-256-GCM with no key derivation — the payload key is 32 raw bytes given as
 * base64. Without the tag check the ciphertext is malleable, and a tampered
 * value would come back as a CORRUPTED PASSWORD rather than an error. That
 * password then goes to MariaDB, which answers "Access denied", which reads as
 * a wrong credential and sends whoever is debugging it somewhere else entirely.
 */

const PREFIX = 'pos:v1:'

/**
 * The key this build was issued.
 *
 * Read from the environment per call rather than cached: runtimeConfig assigns
 * it before the server starts, and a test that flips it must not be answered
 * from a value captured at import time.
 */
function payloadKey(): Buffer {
  const raw = process.env.POS_API_PAYLOAD_KEY?.trim()
  if (!raw) {
    throw new Error('POS_API_PAYLOAD_KEY is not set — this build cannot open portal credentials.')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('POS_API_PAYLOAD_KEY is not 32 bytes — this build cannot open portal credentials.')
  }
  return key
}

/** Is this value one of the portal's sealed envelopes? */
export function isPortalEnvelope(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/**
 * Open one envelope, or throw.
 *
 * Throws rather than returning null on purpose: every caller is about to use
 * the result as a credential, and a null that flowed onward would be indistinct
 * from "there was no password" — which is a different situation with a
 * different fix. The callers catch and decide.
 */
export function openPortalEnvelope(envelope: string): string {
  if (!isPortalEnvelope(envelope)) {
    throw new Error('Not a pos:v1 envelope.')
  }

  /* Split into exactly three, so a base64 value containing ':' cannot shift the
     parts along. The ciphertext may legitimately be empty. */
  const parts = envelope.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Malformed pos:v1 envelope.')
  const [iv, tag, ct] = parts

  const decipher = createDecipheriv('aes-256-gcm', payloadKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ct, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

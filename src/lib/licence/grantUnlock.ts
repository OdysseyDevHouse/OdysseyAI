import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { query, queryOne, execute } from '@/lib/db'
import { tryDecryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { challengeFor, responseFor, normaliseCode, UNLOCK_GRANT_DAYS } from './unlockCode'
import { randomBytes } from 'node:crypto'

/**
 * Issuing an unlock code, on the CONTROL PANEL side.
 *
 * The other half of the telephone call. A locked machine shows a challenge; a
 * supervisor types it in here and reads back the response this produces. Both
 * sides compute the same HMAC over the same shared secret, so nothing has to
 * travel between them — which is the point, because the machine has no line.
 *
 * ── WHY THE CHALLENGE IS SEARCHED FOR, NOT TRUSTED ──────────────────────────
 *
 * The supervisor types in what the customer read out. That tells us the code
 * but not WHICH machine it came from, and a support desk should not have to
 * ask a panicking cashier for a device serial as well.
 *
 * So the challenge is used as the lookup: for each of this site's local
 * backends, recompute what its challenge would be at each plausible counter
 * value and see which one matches. A hit identifies the machine AND proves the
 * code is genuine, because only a machine holding that secret could have
 * displayed it.
 *
 * ── WHY THE COUNTER IS SEARCHED OVER A SMALL WINDOW ─────────────────────────
 *
 * The control panel's idea of how many unlocks a machine has redeemed can lag
 * the machine's own: a code issued and never typed in leaves us one ahead, and
 * a machine restored from a backup can be behind. Searching a few values either
 * way absorbs that without letting an attacker grind — the secret is still
 * required, and without it no amount of counter guessing produces a match.
 */

type Row = RowDataPacket & Record<string, unknown>

/** How far around the recorded counter to look. Small: this covers drift, not attack. */
const COUNTER_WINDOW = 5

export type UnlockGrant = {
  ok: true
  response: string
  deviceSerial: string
  days: number
  /** How long this machine has been silent, so the agent can see a pattern. */
  lastSeenAt: Date | null
  /** Unlocks already granted to this machine. The number that matters. */
  priorGrants: number
}

export type UnlockGrantFailure = { ok: false; error: string }

/**
 * Find the machine a challenge came from, and mint its response.
 *
 * Does NOT record the grant — see recordGrant. Split deliberately: an agent
 * reading a code out and an agent deciding to give one are the same act here,
 * but the ledger entry should describe what was actually handed over, so it is
 * written by the caller that hands it over.
 */
export async function grantUnlock(
  siteId: number,
  suppliedChallenge: string,
): Promise<UnlockGrant | UnlockGrantFailure> {
  const challenge = normaliseCode(suppliedChallenge)
  if (challenge.length === 0) {
    return { ok: false, error: 'Enter the code the customer read out.' }
  }

  const backends = await query<Row>(
    `SELECT device_serial, unlock_secret_enc, last_seen_at
       FROM cp2_local_backends
      WHERE site_id = ? AND status = 'active'`,
    [siteId],
  )

  if (backends.length === 0) {
    return {
      ok: false,
      error: 'This site has no local installation on record, so it cannot be unlocked by code.',
    }
  }

  for (const row of backends) {
    const secret = tryDecryptSecret(row.unlock_secret_enc ? String(row.unlock_secret_enc) : null)
    if (!secret) continue

    const serial = String(row.device_serial)
    const prior = await grantCount(siteId, serial)

    /* Search around the count we know about. The machine's own counter is the
       authority and we only mirror it, so drift in either direction is normal. */
    const from = Math.max(0, prior - COUNTER_WINDOW)
    for (let counter = from; counter <= prior + COUNTER_WINDOW; counter++) {
      const candidate = challengeFor(secret, { siteId, deviceSerial: serial, unlockCounter: counter })
      if (normaliseCode(candidate) !== challenge) continue

      return {
        ok: true,
        response: responseFor(secret, candidate),
        deviceSerial: serial,
        days: UNLOCK_GRANT_DAYS,
        lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)) : null,
        priorGrants: prior,
      }
    }
  }

  return {
    ok: false,
    error:
      'That code does not match any machine at this site. Check it was read correctly, and that the right site is selected.',
  }
}

/**
 * Does this site run at least one local backend?
 *
 * Decides whether the telephone-unlock panel is worth showing at all. Reads the
 * registration table rather than cp2_sites.backoffice_type deliberately: the
 * column records what somebody INTENDED, and this asks whether a machine has
 * actually reported in with a database of its own. A site switched to 'windows'
 * last week but not yet installed has nothing to unlock.
 *
 * Fails to false: a panel that failed to appear is a support call, a panel that
 * appears on every cloud site is a support call from everybody.
 */
export async function siteHasLocalBackend(siteId: number): Promise<boolean> {
  try {
    const row = await queryOne<Row>(
      `SELECT 1 AS present FROM cp2_local_backends
        WHERE site_id = ? AND status = 'active' LIMIT 1`,
      [siteId],
    )
    return Boolean(row)
  } catch {
    return false
  }
}

/** How many unlocks this machine has already had. The number worth looking at. */
async function grantCount(siteId: number, deviceSerial: string): Promise<number> {
  const row = await queryOne<Row>(
    `SELECT COUNT(*) AS n FROM cp2_unlock_grants WHERE site_id = ? AND device_serial = ?`,
    [siteId, deviceSerial],
  )
  return row ? Number(row.n ?? 0) : 0
}

/**
 * Write the grant to the ledger.
 *
 * ── THIS IS THE ACTUAL CONTROL ──────────────────────────────────────────────
 *
 * An offline unlock grants access without verifying anything over the wire, so
 * nothing here can stop a support agent keeping a non-paying shop trading a
 * fortnight at a time. That is inherent to the premise, not a gap in the
 * implementation.
 *
 * What can be done is make it visible. Every code issued names the supervisor,
 * the site, the machine and the moment, so a site appearing four times running
 * is a conversation somebody can actually have. Fails LOUDLY on error rather
 * than silently: an unrecorded grant is the only kind that defeats the point.
 */
export async function recordGrant(input: {
  siteId: number
  deviceSerial: string
  challenge: string
  response: string
  unlockCounter: number
  grantedDays: number
  grantedBy: number | null
  reason: string | null
}): Promise<void> {
  await execute(
    `INSERT INTO cp2_unlock_grants
       (site_id, device_serial, challenge, response, unlock_counter, granted_days, granted_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.siteId,
      input.deviceSerial,
      normaliseCode(input.challenge),
      normaliseCode(input.response),
      input.unlockCounter,
      input.grantedDays,
      input.grantedBy,
      input.reason,
    ],
  )
}

/** Every unlock this site has had, newest first. The report that catches a pattern. */
export async function listGrants(siteId: number, limit = 50) {
  const rows = await query<Row>(
    `SELECT g.id, g.device_serial, g.granted_days, g.reason, g.created_at,
            u.full_name AS granted_by_name
       FROM cp2_unlock_grants g
       LEFT JOIN cp2_users u ON u.id = g.granted_by
      WHERE g.site_id = ?
      ORDER BY g.created_at DESC
      LIMIT ?`,
    [siteId, limit],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    deviceSerial: r.device_serial ? String(r.device_serial) : null,
    grantedDays: Number(r.granted_days ?? 0),
    reason: r.reason ? String(r.reason) : null,
    grantedByName: r.granted_by_name ? String(r.granted_by_name) : null,
    createdAt: r.created_at ? new Date(String(r.created_at)) : null,
  }))
}

/**
 * Register a machine's local backend, and plant its unlock secret.
 *
 * Called when a desktop install first reaches the control panel. The machine
 * generated its own database password and sent it here to be escrowed; we
 * generate the unlock secret and send that back, so neither side has to trust
 * the other to have produced good randomness.
 *
 * Idempotent on (site, serial): a reinstall UPDATES rather than accumulating a
 * history of passwords support would have to choose between. The unlock secret
 * is the exception — once planted it is never rotated, because rotating it
 * would silently invalidate a code already read out over the telephone.
 */
export async function registerLocalBackend(input: {
  siteId: number
  deviceSerial: string
  dbPassword: string | null
  dbPort: number | null
  dbName: string | null
}): Promise<{ unlockSecret: string }> {
  const existing = await queryOne<Row>(
    `SELECT unlock_secret_enc FROM cp2_local_backends WHERE site_id = ? AND device_serial = ? LIMIT 1`,
    [input.siteId, input.deviceSerial],
  )

  const existingSecret = tryDecryptSecret(
    existing?.unlock_secret_enc ? String(existing.unlock_secret_enc) : null,
  )
  const secret = existingSecret || randomBytes(32).toString('base64')

  await execute(
    `INSERT INTO cp2_local_backends
       (site_id, device_serial, db_password_enc, db_port, db_name, unlock_secret_enc, escrowed_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       db_password_enc = COALESCE(VALUES(db_password_enc), db_password_enc),
       db_port = COALESCE(VALUES(db_port), db_port),
       db_name = COALESCE(VALUES(db_name), db_name),
       unlock_secret_enc = COALESCE(unlock_secret_enc, VALUES(unlock_secret_enc)),
       escrowed_at = NOW(),
       last_seen_at = NOW()`,
    [
      input.siteId,
      input.deviceSerial,
      input.dbPassword ? encryptSecret(input.dbPassword) : null,
      input.dbPort,
      input.dbName,
      encryptSecret(secret),
    ],
  )

  return { unlockSecret: secret }
}

/**
 * The escrowed database password, in plain text.
 *
 * A privileged read, and named so it is obvious at the call site that it is
 * happening. The customer must never see this: it is what keeps them out of
 * their own takings, and a shop owner who can edit sales rows directly is a
 * shop whose figures mean nothing.
 */
export async function revealDbPassword(
  siteId: number,
  deviceSerial: string,
): Promise<{ password: string | null; port: number | null; dbName: string | null } | null> {
  const row = await queryOne<Row>(
    `SELECT db_password_enc, db_port, db_name
       FROM cp2_local_backends
      WHERE site_id = ? AND device_serial = ? LIMIT 1`,
    [siteId, deviceSerial],
  )
  if (!row) return null
  return {
    password: tryDecryptSecret(row.db_password_enc ? String(row.db_password_enc) : null),
    port: row.db_port ? Number(row.db_port) : null,
    dbName: row.db_name ? String(row.db_name) : null,
  }
}

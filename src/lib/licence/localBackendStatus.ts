import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { query } from '@/lib/db'
import { tryDecryptSecret } from '@/lib/crypto/secrets'
import { getReplica, type ReportingReplica } from '@/lib/reporting/replicaDb'
import { daysSinceCheck, type Lease } from './leaseRules'
import { readLease } from './lease'

/**
 * Everything support needs to know about a shop that holds its own data.
 *
 * ── WHY ONE READ AND NOT FIVE SCREENS ───────────────────────────────────────
 *
 * A local-backend site has state in three places: the machine (its lease), the
 * control database (what it escrowed), and the replica host (whether the copy
 * is keeping up). A support call starts with one question — "why can this shop
 * not X" — and the answer is in whichever of those three somebody thinks to
 * look at.
 *
 * Gathering them here means the screen shows the whole picture, and an agent
 * does not have to know which of three subsystems is the likely culprit before
 * they can start looking.
 */

type Row = RowDataPacket & Record<string, unknown>

export type LocalBackendMachine = {
  deviceSerial: string
  dbPort: number | null
  dbName: string | null
  escrowedAt: Date | null
  lastSeenAt: Date | null
  /** False when nothing was escrowed, or it will not decrypt with this key. */
  hasEscrowedPassword: boolean
  hasUnlockSecret: boolean
  /** How many times support has released this machine over the telephone. */
  unlockCount: number
  lastUnlockAt: Date | null
}

export type LocalBackendStatus = {
  /** Every machine that has ever escrowed itself for this site. */
  machines: LocalBackendMachine[]
  /** The lease as the SHOP's own database records it, when reachable. */
  lease: Lease | null
  /** Null when this site has no replica provisioned. */
  replica: ReportingReplica | null
}

/**
 * Gather it, tolerating each part being absent.
 *
 * Every read is independent and every failure is local: a missing replica must
 * not hide the escrowed password, and an unreachable shop must not hide the
 * replica's health. A support screen that shows three-quarters of the picture
 * is far better than one that 500s because a shop is switched off.
 */
export async function localBackendStatus(siteId: number): Promise<LocalBackendStatus> {
  const machines = await listMachines(siteId)

  /* The shop's own database. Unreachable is the NORMAL case from head office —
     that is the entire premise of a local backend — so this is expected to
     fail and must cost nothing when it does. */
  const lease = await readLease(siteId).catch(() => null)

  const replica = await getReplica(siteId).catch(() => null)

  return { machines, lease, replica }
}

async function listMachines(siteId: number): Promise<LocalBackendMachine[]> {
  let rows: Row[]
  try {
    rows = await query<Row>(
      `SELECT b.device_serial, b.db_port, b.db_name, b.db_password_enc,
              b.unlock_secret_enc, b.escrowed_at, b.last_seen_at,
              (SELECT COUNT(*) FROM cp2_unlock_grants g
                WHERE g.site_id = b.site_id AND g.device_serial = b.device_serial) AS unlock_count,
              (SELECT MAX(g.created_at) FROM cp2_unlock_grants g
                WHERE g.site_id = b.site_id AND g.device_serial = b.device_serial) AS last_unlock_at
         FROM cp2_local_backends b
        WHERE b.site_id = ? AND b.status = 'active'
        ORDER BY b.escrowed_at DESC`,
      [siteId],
    )
  } catch {
    /* The table may not exist on a control database that has not run
       migration 011. No local backends is the right answer for every cloud
       site, so this must read as "none" rather than as an error. */
    return []
  }

  return rows.map((r) => ({
    deviceSerial: String(r.device_serial),
    dbPort: r.db_port ? Number(r.db_port) : null,
    dbName: r.db_name ? String(r.db_name) : null,
    escrowedAt: r.escrowed_at ? new Date(String(r.escrowed_at)) : null,
    lastSeenAt: r.last_seen_at ? new Date(String(r.last_seen_at)) : null,
    /* Decrypted rather than merely checked for presence: a password that will
       not decrypt is indistinguishable from one that is absent until somebody
       needs it, and finding that out during an incident is the worst moment. */
    hasEscrowedPassword: Boolean(tryDecryptSecret(r.db_password_enc ? String(r.db_password_enc) : null)),
    hasUnlockSecret: Boolean(tryDecryptSecret(r.unlock_secret_enc ? String(r.unlock_secret_enc) : null)),
    unlockCount: Number(r.unlock_count ?? 0),
    lastUnlockAt: r.last_unlock_at ? new Date(String(r.last_unlock_at)) : null,
  }))
}

export type CredentialReveal = {
  deviceSerial: string | null
  credential: string
  revealedByName: string | null
  reason: string
  createdAt: Date | null
}

/**
 * Who has read this site's escrowed credentials.
 *
 * Shown on the same screen as the reveal button, deliberately: the deterrent
 * only works if the person about to read one can see that the last three reads
 * are still there with somebody's name on them.
 */
export async function listCredentialReveals(
  siteId: number,
  limit = 20,
): Promise<CredentialReveal[]> {
  try {
    const rows = await query<Row>(
      `SELECT r.device_serial, r.credential, r.reason, r.created_at,
              u.full_name AS revealed_by_name
         FROM cp2_credential_reveals r
         LEFT JOIN cp2_users u ON u.id = r.revealed_by
        WHERE r.site_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?`,
      [siteId, limit],
    )
    return rows.map((r) => ({
      deviceSerial: r.device_serial ? String(r.device_serial) : null,
      credential: String(r.credential ?? ''),
      revealedByName: r.revealed_by_name ? String(r.revealed_by_name) : null,
      reason: String(r.reason ?? ''),
      createdAt: r.created_at ? new Date(String(r.created_at)) : null,
    }))
  } catch {
    return []
  }
}

/**
 * The one line that says whether this shop is healthy.
 *
 * Deliberately opinionated: an agent scanning a screen needs a verdict, not
 * five numbers to synthesise one from. The order is by severity — the worst
 * true statement wins, because a machine that is both locked and behind on
 * replication has one problem worth naming first.
 */
export function overallVerdict(status: LocalBackendStatus): {
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  headline: string
} {
  if (status.machines.length === 0) {
    return { tone: 'neutral', headline: 'No local installation has registered yet.' }
  }

  const lease = status.lease
  if (lease) {
    const silent = daysSinceCheck(lease)
    if (lease.expiresAt.getTime() <= Date.now()) {
      return { tone: 'danger', headline: `Locked — no licence check for ${silent} days.` }
    }
    if (silent >= 3) {
      return { tone: 'warning', headline: `Trading, but has not checked in for ${silent} days.` }
    }
  }

  const replica = status.replica
  if (!replica) {
    return { tone: 'warning', headline: 'Installed and trading, but no reporting replica yet.' }
  }
  if (replica.status !== 'running') {
    return { tone: 'danger', headline: `Reporting replica is ${replica.status}.` }
  }
  if (replica.secondsBehind !== null && replica.secondsBehind > 300) {
    const mins = Math.round(replica.secondsBehind / 60)
    return { tone: 'warning', headline: `Reporting is ${mins} minutes behind the shop.` }
  }

  return { tone: 'success', headline: 'Trading, checked in, and reporting is up to date.' }
}

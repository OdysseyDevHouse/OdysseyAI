import 'server-only'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { queryOne } from '@/lib/db'
import { tryDecryptSecret } from '@/lib/crypto/secrets'

/**
 * Reading a local shop's data from its cloud replica.
 *
 * ── WHY THIS IS NOT siteDb.ts ───────────────────────────────────────────────
 *
 * siteDb.ts resolves the database a site is WRITTEN to. Every caller it has —
 * the till posting a sale, the migration runner, every server action — expects
 * a connection it may mutate.
 *
 * A replica must never be written to. A write would either be overwritten by
 * the next replication event or, worse, silently diverge the copy from the
 * shop, and a reporting database that disagrees with the till is worse than no
 * reporting database at all.
 *
 * Keeping this in its own module, reading its own table, means there is no path
 * by which an existing caller reaches a replica by accident. `siteQuery()`
 * cannot resolve to one, because `sitePool()` does not look here. That
 * separation is the safety property — a shared table with an `is_replica` flag
 * would have relied on every caller remembering to check it.
 *
 * ── EVERY EXPORT HERE IS READ-ONLY ──────────────────────────────────────────
 *
 * There is deliberately no `replicaExecute`, no `replicaTransaction`, and the
 * pool's user is granted SELECT alone. Three layers saying the same thing, so
 * that adding a write means noticing three times that it is wrong.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ReplicaStatus = 'pending' | 'running' | 'stopped' | 'error'

export type ReportingReplica = {
  siteId: number
  deviceSerial: string | null
  host: string
  port: number
  databaseName: string
  status: ReplicaStatus
  /** Seconds behind the shop. Null means replication is not running at all — a
   *  different and more serious state than zero. */
  secondsBehind: number | null
  lastContactAt: Date | null
  lastError: string | null
  /** False when the password is missing or will not decrypt. */
  credentialsUsable: boolean
}

const SELECT_REPLICA = `
  SELECT site_id, device_serial, server_host, server_port, database_name,
         db_username, db_password_enc, status, seconds_behind,
         last_contact_at, last_error
    FROM cp2_reporting_replicas`

function mapRow(row: Row): ReportingReplica {
  return {
    siteId: Number(row.site_id),
    deviceSerial: row.device_serial ? String(row.device_serial) : null,
    host: String(row.server_host ?? ''),
    port: Number(row.server_port || 3306),
    databaseName: String(row.database_name ?? ''),
    status: (String(row.status ?? 'pending') as ReplicaStatus) || 'pending',
    secondsBehind: row.seconds_behind === null || row.seconds_behind === undefined
      ? null
      : Number(row.seconds_behind),
    lastContactAt: row.last_contact_at ? new Date(String(row.last_contact_at)) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    credentialsUsable: Boolean(tryDecryptSecret(
      row.db_password_enc ? String(row.db_password_enc) : null,
    )),
  }
}

/** The replica for a site, or null if it has none. Most sites have none. */
export async function getReplica(siteId: number): Promise<ReportingReplica | null> {
  try {
    const row = await queryOne<Row>(
      `${SELECT_REPLICA} WHERE site_id = ? ORDER BY id LIMIT 1`,
      [siteId],
    )
    return row ? mapRow(row) : null
  } catch {
    /* The table may not exist yet on a control database that has not run
       migration 012. A site with no replica is the overwhelmingly common case,
       so this must read as "none" rather than as an error. */
    return null
  }
}

/**
 * How far behind a replica may fall before its data should not be presented as
 * current.
 *
 * Five minutes: long enough to ride out a shop's flaky line and the ordinary
 * catch-up after one, short enough that nobody makes a decision on figures that
 * are meaningfully stale. A report served from a lagging replica is not refused
 * — it is LABELLED, because "yesterday's number, clearly marked" is useful and
 * "a number that is quietly wrong" is not.
 */
export const STALE_AFTER_SECONDS = 300

export function isStale(replica: ReportingReplica): boolean {
  if (replica.status !== 'running') return true
  if (replica.secondsBehind === null) return true
  return replica.secondsBehind > STALE_AFTER_SECONDS
}

const globalForReplica = globalThis as unknown as {
  odysseyReplicaPools?: Map<number, Pool>
}

function poolCache(): Map<number, Pool> {
  if (!globalForReplica.odysseyReplicaPools) globalForReplica.odysseyReplicaPools = new Map()
  return globalForReplica.odysseyReplicaPools
}

export class ReplicaError extends Error {}

/**
 * A pool for one site's replica.
 *
 * Cached per site like sitePool, and for the same reason: a new handshake per
 * page load would cost more than the query.
 */
export async function replicaPool(siteId: number): Promise<Pool> {
  const cached = poolCache().get(siteId)
  if (cached) return cached

  const row = await queryOne<Row>(
    `${SELECT_REPLICA} WHERE site_id = ? ORDER BY id LIMIT 1`,
    [siteId],
  )
  if (!row) throw new ReplicaError(`Site ${siteId} has no reporting replica.`)

  const password = tryDecryptSecret(row.db_password_enc ? String(row.db_password_enc) : null)
  if (password === null) {
    throw new ReplicaError(
      `Replica credentials for site ${siteId} could not be decrypted — ` +
        'ENCRYPTION_KEY may not match the backend that wrote them.',
    )
  }

  const pool = mysql.createPool({
    host: String(row.server_host ?? ''),
    port: Number(row.server_port || 3306),
    user: String(row.db_username ?? ''),
    password,
    database: String(row.database_name ?? ''),
    connectionLimit: Number(process.env.REPLICA_DB_CONNECTION_LIMIT || 5),
    waitForConnections: true,
    charset: 'utf8mb4_unicode_ci',
    /* Identical to sitePool's settings, and that is load-bearing rather than
       tidy: the report engine builds one SQL string and must get the same
       types back whichever connection runs it. A replica that returned
       DECIMALs as floats would quietly change every total. */
    timezone: 'Z',
    decimalNumbers: false,
    dateStrings: ['DATE'],
  })

  poolCache().set(siteId, pool)
  return pool
}

/** Read from a site's replica. The only way to query one. */
export async function replicaQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await replicaPool(siteId)
  const [rows] = await pool.execute(sql, params as never)
  return rows as T[]
}

/** Drop a cached pool — after its credentials change, or it is re-pointed. */
export function invalidateReplicaPool(siteId: number): void {
  const pool = poolCache().get(siteId)
  if (!pool) return
  poolCache().delete(siteId)
  void pool.end().catch(() => {
    /* Already closing, or never connected. Nothing to do. */
  })
}

/**
 * Is the replica actually usable right now?
 *
 * Probes rather than trusting the recorded status, because that status is
 * written by the replication host and can itself be stale. Used by the setup
 * screen, not on the reporting path — a report should not pay for a probe.
 */
export async function probeReplica(
  siteId: number,
): Promise<{ ok: true; secondsBehind: number | null } | { ok: false; error: string }> {
  try {
    const rows = await replicaQuery<Row>(siteId, 'SELECT 1 AS ok')
    if (!rows.length) return { ok: false, error: 'The replica did not answer.' }
    const replica = await getReplica(siteId)
    return { ok: true, secondsBehind: replica?.secondsBehind ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

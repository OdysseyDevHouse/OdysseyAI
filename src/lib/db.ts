import 'server-only'
import mysql from 'mysql2/promise'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { decryptSecret } from './crypto/secrets'

/**
 * The CONTROL database (odyssey_tickets).
 *
 * It holds who may sign in (cp2_users), which sites they may see
 * (cp2_user_sites -> cp2_sites) and where each site's real data lives
 * (cp2_site_databases). It holds no trading data itself — for that, see
 * siteDb.ts, which uses the connection details stored here.
 */

// One pool per process. Next re-evaluates modules on every hot reload, so
// without the global stash each edit would leak a pool until MySQL refused
// new connections.
const globalForDb = globalThis as unknown as { odysseyControlPool?: Pool }

function createPool(): Pool {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    /**
     * DB_PASSWORD may arrive encrypted, and on a shared server it should.
     *
     * The v2 backend keeps this credential as an `enc:v1:` envelope in its own
     * .env and decrypts on the way to MySQL (utils/secret.ts). Reading it raw
     * here meant a .env copied from that backend — the obvious thing to do,
     * since both connect to the SAME odyssey_tickets — sent the literal
     * ciphertext as the password. MySQL's answer to that is
     *
     *     Access denied for user 'X'@'host' (using password: YES)
     *
     * which reads as a wrong password or a missing grant and is neither.
     *
     * secrets.ts already implements that exact envelope byte for byte, because
     * it has to read cp2_site_databases.db_password_enc written by the same
     * backend. So this is not a new format to support — it is the one already
     * in the process, applied to the one credential that was missing it.
     *
     * Plaintext passes straight through, so a desktop install (whose value
     * comes from buildDefaults.json) and every existing .env keep working.
     */
    password: decryptSecret(process.env.DB_PASSWORD),
    database: process.env.DB_NAME || 'odyssey_tickets',
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    waitForConnections: true,
    /**
     * ── AN IDLE POOLED CONNECTION DIES SILENTLY, AND THE POOL HANDS IT OUT ──
     *
     * The control database is the one connection in this app that leaves the
     * building: a shop's line, its router's NAT table and the host's firewall
     * all sit between the pool and 105.30.57.88. Any of them may forget an idle
     * flow without telling either end. Nothing observes that until the next
     * query is written into the dead socket, at which point Windows retransmits
     * for ~19 seconds before giving up with ECONNRESET.
     *
     * That is exactly what a phone enrolling through /api/mobile/auth/login hit
     * — a 19-second wait and then "could not sign in", from a database that was
     * up the whole time and answered a fresh connection in 133ms.
     *
     * mysql2's two relevant defaults both leave the door open:
     *
     *   · `maxIdle` defaults to `connectionLimit`, and base/pool.js only starts
     *     its idle reaper when maxIdle is the SMALLER of the two. Equal means no
     *     reaper: an idle connection is kept for the life of the process.
     *   · keep-alive is on, but `keepAliveInitialDelay` is undefined, which
     *     Node passes to the OS as "use your default" — two hours on Windows.
     *     Long dead by the time the first probe is sent.
     *
     * So both are set explicitly. Probing every 10 seconds keeps the flow alive
     * in every NAT table on the path AND surfaces a dead peer as a socket error
     * — which mysql2 handles by dropping the connection from the pool — rather
     * than as a 19-second stall inside somebody's sign-in. Holding at most two
     * idle connections then bounds how many stale ones can accumulate at all.
     */
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    maxIdle: 2,
    idleTimeout: 30_000,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    // DECIMAL columns arrive as strings — money must not round-trip through a
    // float. Callers convert explicitly via decimals.ts.
    decimalNumbers: false,
    dateStrings: ['DATE'],
  })
}

/**
 * Drops the cached pool so the next call re-reads the environment.
 *
 * mysql2 builds a pool without connecting, so a pool aimed at a wrong or
 * unresolvable host is cached exactly like a working one and keeps failing
 * identically for the life of the process. Editing DB_HOST then has no visible
 * effect and the natural conclusion is that the edit did not take — see
 * invalidateSitePool in siteDb.ts, which exists for the same reason.
 */
export function invalidateControlPool(): void {
  const existing = globalForDb.odysseyControlPool
  if (!existing) return
  globalForDb.odysseyControlPool = undefined
  void existing.end().catch(() => {})
}

/**
 * Thrown instead of opening a control-database socket on a desktop install.
 *
 * Its own class so a caller can tell "this build does not do that" apart from
 * "the database refused us" — the two need opposite responses, and a bare
 * Error would make them indistinguishable at the catch site.
 */
export class ControlDbUnavailableOnDesktop extends Error {
  constructor(detail?: string) {
    super(
      'This build does not connect to the control database. ' +
        'The answer must come from the POS API' +
        (detail ? ` (${detail})` : '') +
        '.',
    )
    this.name = 'ControlDbUnavailableOnDesktop'
  }
}

/**
 * Does this build reach the control database at all?
 *
 * ── WHY A REFUSAL RATHER THAN A FALLBACK ────────────────────────────────────
 *
 * A packaged Electron install has no business opening a socket to
 * odyssey_tickets, for two reasons that point the same way.
 *
 * It cannot: the control database accepts connections from our own servers, not
 * from a shop's ADSL line. Every such call was already failing in the field —
 * silently, because the callers catch and degrade, so the machine simply never
 * renewed its lease and counted down to a lock screen with nothing visibly
 * wrong. That is the failure lib/control/portalApi.ts exists to end.
 *
 * And it must not: reaching that database means the installer has to CARRY the
 * credentials for it, and an asar unpacks in seconds. DB_HOST, DB_USER,
 * DB_PASSWORD and ENCRYPTION_KEY baked into every download are the keys to
 * every shop on the platform. Removing the last caller is what lets those keys
 * come out of the build — see scripts/make-build-defaults.mjs.
 *
 * ── WHY HERE, AND NOT AT EACH CALL SITE ─────────────────────────────────────
 *
 * There are more than twenty of them, and the ones that matter are the ones
 * nobody remembered. A guard on each is a list that goes stale the first time
 * somebody adds a query; a guard on the one function that opens the socket
 * cannot be bypassed by code that has not been written yet.
 *
 * It is deliberately LOUD. A desktop caller that reaches here has a missing
 * portal route, and the throw is what makes that visible in testing instead of
 * arriving as a silent degradation at a customer's counter.
 */
function reachesControlDb(): boolean {
  return process.env.APP_MODE !== 'desktop'
}

export function pool(): Pool {
  if (!reachesControlDb()) throw new ControlDbUnavailableOnDesktop()
  if (!globalForDb.odysseyControlPool) globalForDb.odysseyControlPool = createPool()
  return globalForDb.odysseyControlPool
}

// mysql2 types params as a closed union it can serialise. Callers build arrays
// of mixed shape, so the cast happens once here rather than at every call site.
type SqlParams = Parameters<Pool['execute']>[1]
const asParams = (params: unknown[]) => params as SqlParams

/**
 * A connection that died under us, as opposed to a statement the server
 * refused. mysql2 flags the first kind `fatal` and gives it a socket-level
 * code; a syntax error or a constraint violation carries neither.
 */
function isDeadConnection(err: unknown): boolean {
  const e = err as { code?: string; fatal?: boolean }
  return (
    e?.fatal === true &&
    ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(e.code ?? '')
  )
}

/**
 * SELECT returning rows.
 *
 * Retried ONCE when the connection turns out to have been dead, because the
 * keep-alive above narrows that window rather than closing it: a flow can still
 * be dropped between one probe and the query that follows it. The failure
 * evicts the corpse from the pool, so the second attempt draws a fresh
 * connection and succeeds — which is precisely what the pool does on its own
 * one request later, at the cost of one user seeing an error first.
 *
 * ── WHY ONLY READS ──────────────────────────────────────────────────────────
 *
 * A SELECT can be repeated because repeating it changes nothing. `execute` and
 * `transaction` below deliberately do NOT retry: an INSERT whose connection
 * dropped may or may not have been applied by the server before the socket
 * went, and a retry that guesses wrong writes the row twice. A failed write
 * that surfaces is recoverable; a silently duplicated one is not.
 */
export async function query<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const [rows] = await pool().execute(sql, asParams(params))
    return rows as T[]
  } catch (err) {
    if (!isDeadConnection(err)) throw err
    const [rows] = await pool().execute(sql, asParams(params))
    return rows as T[]
  }
}

/** SELECT returning at most one row. */
export async function queryOne<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

/** INSERT/UPDATE/DELETE returning affectedRows / insertId. */
export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await pool().execute(sql, asParams(params))
  return result as ResultSetHeader
}

/**
 * Runs `fn` inside a transaction on a single dedicated connection, rolling back
 * on any throw. The callback gets that connection — it must use it rather than
 * the module-level helpers above, which draw a different connection from the
 * pool and would sit outside the transaction.
 */
export async function transaction<T>(fn: (tx: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool().getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

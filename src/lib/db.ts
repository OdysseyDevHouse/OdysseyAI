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

export function pool(): Pool {
  if (!globalForDb.odysseyControlPool) globalForDb.odysseyControlPool = createPool()
  return globalForDb.odysseyControlPool
}

// mysql2 types params as a closed union it can serialise. Callers build arrays
// of mixed shape, so the cast happens once here rather than at every call site.
type SqlParams = Parameters<Pool['execute']>[1]
const asParams = (params: unknown[]) => params as SqlParams

/** SELECT returning rows. */
export async function query<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool().execute(sql, asParams(params))
  return rows as T[]
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

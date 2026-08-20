import 'server-only'
import mysql from 'mysql2/promise'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { query, queryOne } from './db'
import { decryptSecret } from './crypto/secrets'

/**
 * Reads a stored database password.
 *
 * An empty or NULL column means "no password", which is a valid configuration
 * and must not be reported as a decryption failure — those are very different
 * problems and conflating them sends people hunting for the wrong bug.
 */
function readPassword(enc: string | null): { ok: true; value: string } | { ok: false } {
  if (enc === null || enc === undefined || enc === '') return { ok: true, value: '' }
  try {
    return { ok: true, value: decryptSecret(enc) }
  } catch {
    return { ok: false }
  }
}

/**
 * Connections to each SITE's own database, routed through
 * cp2_site_databases in the control database.
 *
 * A site can have several databases, one per `purpose` (stock_file,
 * customer_file, …), so a connection is identified by (siteId, purpose).
 */

export type SitePurpose = string

export type SiteDatabase = {
  id: number
  siteId: number
  purpose: SitePurpose
  locationName: string
  host: string
  port: number
  databaseName: string
  username: string | null
  engine: string
  status: 'active' | 'inactive'
  /** False when db_password_enc is missing or SECRETS_KEY can't decrypt it. */
  credentialsUsable: boolean
}

type SiteDbRow = RowDataPacket & {
  id: number
  site_id: number
  purpose: string
  location_name: string
  server_host: string
  server_port: number
  database_name: string
  db_username: string | null
  db_password_enc: string | null
  db_engine: string
  status: 'active' | 'inactive'
}

/**
 * Rows store `localhost`, meaning localhost *of the database server*. When this
 * app runs anywhere else that value points at the wrong machine, so
 * SITE_DB_HOST_OVERRIDE lets a developer redirect every site connection at the
 * real server without editing production rows.
 */
function resolveHost(stored: string): string {
  const override = process.env.SITE_DB_HOST_OVERRIDE?.trim()
  if (override) return override
  return stored
}

function mapRow(r: SiteDbRow): SiteDatabase {
  return {
    id: r.id,
    siteId: r.site_id,
    purpose: r.purpose,
    locationName: r.location_name,
    host: resolveHost(r.server_host),
    port: r.server_port || 3306,
    databaseName: r.database_name,
    username: r.db_username,
    engine: r.db_engine,
    status: r.status,
    credentialsUsable: readPassword(r.db_password_enc).ok,
  }
}

const SELECT_DB = `
  SELECT id, site_id, purpose, location_name, server_host, server_port,
         database_name, db_username, db_password_enc, db_engine, status
    FROM cp2_site_databases
`

/** Every database configured for a site — for a connection-status screen. */
export async function listSiteDatabases(siteId: number): Promise<SiteDatabase[]> {
  const rows = await query<SiteDbRow>(`${SELECT_DB} WHERE site_id = ? ORDER BY purpose ASC`, [
    siteId,
  ])
  return rows.map(mapRow)
}

export async function getSiteDatabase(
  siteId: number,
  purpose: SitePurpose,
): Promise<SiteDatabase | null> {
  const row = await queryOne<SiteDbRow>(
    `${SELECT_DB} WHERE site_id = ? AND purpose = ? AND status = 'active' LIMIT 1`,
    [siteId, purpose],
  )
  return row ? mapRow(row) : null
}

// Pools are cached per (site, purpose) and reused. Creating one per request
// would open a new TCP connection and handshake on every page load.
const globalForSiteDb = globalThis as unknown as {
  odysseySitePools?: Map<string, Pool>
}

function poolCache(): Map<string, Pool> {
  if (!globalForSiteDb.odysseySitePools) globalForSiteDb.odysseySitePools = new Map()
  return globalForSiteDb.odysseySitePools
}

export class SiteDbError extends Error {}

/**
 * A pool for one site's database.
 *
 * Throws rather than returning null: every caller needs a live connection, and
 * a null here would surface much later as a confusing "cannot read property of
 * null" far from the real cause.
 */
export async function sitePool(siteId: number, purpose: SitePurpose): Promise<Pool> {
  const cacheKey = `${siteId}:${purpose}`
  const cached = poolCache().get(cacheKey)
  if (cached) return cached

  const row = await queryOne<SiteDbRow>(
    `${SELECT_DB} WHERE site_id = ? AND purpose = ? AND status = 'active' LIMIT 1`,
    [siteId, purpose],
  )
  if (!row) {
    throw new SiteDbError(`No active "${purpose}" database configured for site ${siteId}.`)
  }

  const password = readPassword(row.db_password_enc)
  if (!password.ok) {
    throw new SiteDbError(
      `Stored credentials for site ${siteId} "${purpose}" could not be decrypted — ` +
        `ENCRYPTION_KEY may not match the backend that wrote them.`,
    )
  }

  const pool = mysql.createPool({
    host: resolveHost(row.server_host),
    port: row.server_port || 3306,
    user: row.db_username || '',
    password: password.value,
    database: row.database_name,
    connectionLimit: Number(process.env.SITE_DB_CONNECTION_LIMIT || 5),
    waitForConnections: true,
    /*
     * How long to wait for a database that is not answering.
     *
     * Without this the driver takes the OS default — measured at ~10 seconds on
     * an unroutable host. That was survivable while every site only ever opened
     * its OWN database, which is either up or the whole request is doomed
     * anyway. It is not survivable now: a store group may share one customer
     * file, so a till on a working machine can be waiting on a SIBLING store's
     * database, and ten seconds at a counter with a queue is an outage.
     *
     * Four seconds is long enough to ride out a blip on a local network and
     * short enough that the cashier gets an answer — "cannot check the balance,
     * take cash" — rather than a frozen screen. See creditRefusal in
     * salesPosting.ts, which turns the failure into that sentence.
     */
    connectTimeout: Number(process.env.SITE_DB_CONNECT_TIMEOUT_MS || 4000),
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    decimalNumbers: false,
    dateStrings: ['DATE'],
  })

  poolCache().set(cacheKey, pool)
  return pool
}

/**
 * The purpose name of the database holding a site's trading data. Everything
 * product-related lives here; other purposes exist for other concerns.
 */
export const MASTER = 'master'

export async function siteQuery<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
  purpose: SitePurpose = MASTER,
): Promise<T[]> {
  const pool = await sitePool(siteId, purpose)
  const [rows] = await pool.execute(sql, params as never)
  return rows as T[]
}

export async function siteQueryOne<T = RowDataPacket>(
  siteId: number,
  sql: string,
  params: unknown[] = [],
  purpose: SitePurpose = MASTER,
): Promise<T | null> {
  const rows = await siteQuery<T>(siteId, sql, params, purpose)
  return rows[0] ?? null
}

export async function siteExecute(
  siteId: number,
  sql: string,
  params: unknown[] = [],
  purpose: SitePurpose = MASTER,
): Promise<ResultSetHeader> {
  const pool = await sitePool(siteId, purpose)
  const [result] = await pool.execute(sql, params as never)
  return result as ResultSetHeader
}

/** Runs `fn` in a transaction on the site's database, rolling back on throw. */
export async function siteTransaction<T>(
  siteId: number,
  fn: (tx: PoolConnection) => Promise<T>,
  purpose: SitePurpose = MASTER,
): Promise<T> {
  const pool = await sitePool(siteId, purpose)
  const conn = await pool.getConnection()
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

/**
 * Drops a cached pool so the next call re-reads cp2_site_databases. Without
 * this, changing a site's stored credentials would not take effect until the
 * process restarted.
 */
export function invalidateSitePool(siteId: number, purpose: SitePurpose = MASTER): void {
  const key = `${siteId}:${purpose}`
  const pool = poolCache().get(key)
  if (pool) {
    poolCache().delete(key)
    void pool.end().catch(() => {})
  }
}

export type SiteDbProbe = {
  ok: boolean
  purpose: string
  target: string
  error: string | null
}

/**
 * Opens a connection and runs SELECT 1, reporting the outcome rather than
 * throwing — for the status screen, which should show a red line, not a 500.
 */
export async function probeSiteDatabase(
  siteId: number,
  purpose: SitePurpose,
): Promise<SiteDbProbe> {
  const config = await getSiteDatabase(siteId, purpose)
  const target = config ? `${config.host}:${config.port}/${config.databaseName}` : '—'

  try {
    const pool = await sitePool(siteId, purpose)
    await pool.query('SELECT 1')
    return { ok: true, purpose, target, error: null }
  } catch (err) {
    return {
      ok: false,
      purpose,
      target,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

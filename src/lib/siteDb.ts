import 'server-only'
import mysql from 'mysql2/promise'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { query, queryOne } from './db'
import { decryptSecret } from './crypto/secrets'
import { siteDatabaseFor } from './control/siteDatabasesPortal'

/**
 * Is this a machine that should ask the portal before the control database?
 *
 * Desktop only. A cloud install and the web build reach cp2_site_databases over
 * the same network as everything else they need, so a signed HTTPS round trip
 * in front of every site pool would be a slower way to reach the same row — and
 * the portal answers only for the ONE site whose key the machine holds, which
 * is exactly wrong for a server serving many.
 */
function isPortalCandidate(): boolean {
  return process.env.APP_MODE === 'desktop'
}

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

/**
 * The connection this machine was GIVEN, when it was given one.
 *
 * ── WHY A LOCAL INSTALL CANNOT LOOK THIS UP ─────────────────────────────────
 *
 * The lookup below reads cp2_site_databases, which lives in the CONTROL
 * database. On a cloud site that is right and is the single source of truth.
 * On a shop's own machine it is impossible: the whole promise of a local
 * install is that it opens on a morning when the line is down, and there is no
 * local copy of that table to read instead.
 *
 * So OdysseyAI Database Setup — which DID have the control panel in front of it —
 * writes the connection where this install can find it, and
 * electron/runtimeConfig.js hands it over in the environment. See
 * docs/plans/database-setup-app.md.
 *
 * This is the same idea as SITE_DB_HOST_OVERRIDE, which has always existed for
 * exactly this problem and only ever covered one field of four.
 *
 * The trade is real and worth naming: an install holding these no longer hears
 * about a change made in the control panel. Re-running OdysseyAI Database Setup
 * is what re-points it — the "Retrieve new details" path, which already exists
 * and is already safe to re-run.
 */
function givenConnection(siteId: number, purpose: SitePurpose): SiteDatabase | null {
  const host = process.env.ODYSSEY_SITE_DB_HOST?.trim()
  const name = process.env.ODYSSEY_SITE_DB_NAME?.trim()
  const user = process.env.ODYSSEY_SITE_DB_USER?.trim()
  const password = process.env.ODYSSEY_SITE_DB_PASSWORD
  if (!host || !name || !user || !password) return null

  /* One machine, one shop. A request for some OTHER site is not something to
     answer from here — it would hand back this shop's database under another
     shop's id, which is the worst possible way to be wrong. Fall through and
     let the ordinary lookup fail honestly. */
  const own = Number(process.env.ODYSSEY_SITE_ID)
  if (!Number.isFinite(own) || own !== siteId) return null

  /* Only the site's own master. A hybrid spool box is a different record with a
     different lifecycle, and this file describes the one database Setup made. */
  if (purpose !== 'master') return null

  return {
    id: 0,
    siteId,
    purpose,
    locationName: 'This machine',
    host,
    port: Number(process.env.ODYSSEY_SITE_DB_PORT) || 3306,
    databaseName: name,
    username: user,
    engine: 'mariadb',
    status: 'active',
    credentialsUsable: true,
  }
}

export async function getSiteDatabase(
  siteId: number,
  purpose: SitePurpose,
): Promise<SiteDatabase | null> {
  const given = givenConnection(siteId, purpose)
  if (given) return given

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

  /* ── THE CONNECTION THIS MACHINE WAS GIVEN, BEFORE ASKING FOR ONE ─────────
   *
   * Checked here as well as in getSiteDatabase, and not merely for symmetry:
   * this is the path that actually opens a socket. Reading it from
   * cp2_site_databases would put a control-database query in front of every
   * single site query, which is exactly the dependency a local install exists
   * to be free of — the shop would stop trading when the line dropped.
   *
   * The password comes straight from the environment rather than through
   * readPassword: it was never ENCRYPTION_KEY-encrypted, because it did not
   * come from the control database. runtimeConfig unsealed it from DPAPI on the
   * way in. */
  const given = givenConnection(siteId, purpose)

  /* ── AND THE ONE THE PORTAL CAN DESCRIBE, BEFORE READING cp2_site_databases ─
   *
   * givenConnection covers the `master` purpose and stops there, deliberately:
   * Setup provisioned ONE database on this machine and a hybrid site's in-store
   * box is a different record with a different lifecycle. So every non-master
   * lookup fell through to the query below — a direct read of the control
   * database on port 3306, and the last one an adopted install still made in
   * normal operation.
   *
   * Asked over the portal instead, where there is a key to ask with. Null means
   * no key, no line, or an answer that was not one, and the query below then
   * runs exactly as it always did — which on a cloud install is the ordinary
   * path and the right one.
   *
   * Not consulted when `given` already answered: that is a value this machine
   * was handed at provisioning time and it must not be second-guessed by a
   * network call on the hot path of every site query. */
  const viaPortal =
    given || !isPortalCandidate()
      ? null
      : await siteDatabaseFor(purpose).catch(() => null)

  const row =
    given || viaPortal
      ? null
      : await queryOne<SiteDbRow>(
          `${SELECT_DB} WHERE site_id = ? AND purpose = ? AND status = 'active' LIMIT 1`,
          [siteId, purpose],
        )
  if (!given && !viaPortal && !row) {
    throw new SiteDbError(`No active "${purpose}" database configured for site ${siteId}.`)
  }

  /* The portal's password arrived opened — it travels `pos:v1:` sealed to this
     build's payload key rather than ENCRYPTION_KEY-sealed, and
     siteDatabasesPortal has already unwrapped it. A row it could not open is
     dropped there rather than surfaced here with an empty credential. */
  const password = given
    ? { ok: true as const, value: String(process.env.ODYSSEY_SITE_DB_PASSWORD) }
    : viaPortal
      ? { ok: true as const, value: viaPortal.password ?? '' }
      : readPassword(row!.db_password_enc)
  if (!password.ok) {
    throw new SiteDbError(
      `Stored credentials for site ${siteId} "${purpose}" could not be decrypted — ` +
        `ENCRYPTION_KEY may not match the backend that wrote them.`,
    )
  }

  const pool = mysql.createPool({
    host: given ? given.host : viaPortal ? resolveHost(viaPortal.host) : resolveHost(row!.server_host),
    port: given ? given.port : viaPortal ? viaPortal.port : row!.server_port || 3306,
    user: given ? given.username || '' : viaPortal ? viaPortal.username || '' : row!.db_username || '',
    password: password.value,
    database: given ? given.databaseName : viaPortal ? viaPortal.databaseName : row!.database_name,
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
/**
 * Drops every cached pool.
 *
 * The per-site version above is the one to use when a known site's stored
 * credentials changed. This is for the other case: a connection setting that
 * governs ALL of them — SITE_DB_HOST_OVERRIDE, or a corrected DNS name — where
 * the caller cannot say which sites are affected because the answer is "any of
 * them", and where it may not know a site id at all, having failed before it
 * could resolve one.
 *
 * Costs only the reconnection it forces: pools are rebuilt lazily on next use.
 */
export function invalidateAllSitePools(): void {
  const cache = poolCache()
  for (const [key, pool] of cache) {
    cache.delete(key)
    void pool.end().catch(() => {})
  }
}

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
